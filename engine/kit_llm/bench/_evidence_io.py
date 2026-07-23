"""Durable local-filesystem primitives for scientific evidence bundles.

This module deliberately knows nothing about providers or experiment schemas.
It supplies the small, fail-closed storage boundary used by the evidence
writer: canonical JSON, strict readers, same-directory atomic replacement,
append-and-fsync JSONL, contained regular-file checks, and a lifetime campaign
lock.  The helpers never follow a final-component symlink.
"""

from __future__ import annotations

import errno
import hashlib
import json
import math
import os
import stat
import threading
import uuid
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from kit_llm.bench.harness import (
    BenchArtifactError,
    LockUnavailable,
    RunLocked,
)


_MAX_JSON_DEPTH = 100
_JSON_TYPES = (type(None), bool, int, float, str, list, dict)
_APPEND_LOCKS_GUARD = threading.Lock()
_APPEND_LOCKS: dict[str, threading.Lock] = {}


def canonical_json_bytes(value: Any, *, where: str) -> bytes:
    """Return Kit's canonical UTF-8 JSON bytes, without a trailing newline.

    Only the actual JSON data model is accepted.  In particular, the function
    never falls back to ``repr``/``str`` and rejects non-finite floats, cycles,
    non-string object keys, tuples, sets, dataclasses, and arbitrary objects.
    Callers writing a JSON document append one LF; :func:`append_jsonl` does so
    itself.
    """

    _validate_json(value, where=where, active=set(), depth=0)
    try:
        text = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        return text.encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeError, OverflowError) as error:
        raise BenchArtifactError(f"{where} is not canonical UTF-8 JSON") from error


def strict_load_json(path: str | Path, *, where: str) -> Any:
    """Read one strict UTF-8 JSON document ending in exactly a terminal LF.

    Whitespace and object-key order are not required to be canonical, because
    the reader also audits imported apparatus files.  Syntax is strict:
    duplicate object keys, a UTF-8 BOM, invalid UTF-8, non-finite numbers,
    blank input, and a missing terminal newline are rejected.
    """

    source = Path(path)
    raw = _read_regular_bytes(source, where=where)
    if raw.startswith(b"\xef\xbb\xbf"):
        raise BenchArtifactError(f"{where} must not contain a UTF-8 BOM")
    if not raw:
        raise BenchArtifactError(f"{where} must not be empty")
    if not raw.endswith(b"\n"):
        raise BenchArtifactError(f"{where} is missing its terminal LF")
    if b"\r" in raw:
        raise BenchArtifactError(f"{where} must use LF rather than CRLF line endings")
    if raw[:-1].endswith(b"\n"):
        raise BenchArtifactError(f"{where} has a blank trailing line")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise BenchArtifactError(f"{where} is not strict UTF-8") from error
    value = _strict_loads(text, where=where)
    _validate_json(value, where=where, active=set(), depth=0)
    return value


def strict_load_jsonl(path: str | Path, *, where: str) -> tuple[dict[str, Any], ...]:
    """Read strict object-per-line UTF-8 JSONL.

    An existing zero-byte journal is the valid empty sequence.  Every nonempty
    journal must end in LF; blank records and torn final records are errors.
    """

    source = Path(path)
    raw = _read_regular_bytes(source, where=where)
    if not raw:
        return ()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise BenchArtifactError(f"{where} must not contain a UTF-8 BOM")
    if not raw.endswith(b"\n"):
        raise BenchArtifactError(f"{where} is missing its terminal LF or has a torn record")
    if b"\r" in raw:
        raise BenchArtifactError(f"{where} must use LF rather than CRLF line endings")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise BenchArtifactError(f"{where} is not strict UTF-8") from error

    records: list[dict[str, Any]] = []
    # The final split member is empty solely because the file ends in LF.
    for line_number, line in enumerate(text.split("\n")[:-1], 1):
        record_where = f"{where} line {line_number}"
        if not line.strip():
            raise BenchArtifactError(f"{record_where} is blank")
        value = _strict_loads(line, where=record_where)
        _validate_json(value, where=record_where, active=set(), depth=0)
        if not isinstance(value, dict):
            raise BenchArtifactError(f"{record_where} must be a JSON object")
        records.append(value)
    return tuple(records)


def read_regular_bytes(path: str | Path, *, where: str) -> bytes:
    """Read exact bytes through the same no-symlink, single-link boundary."""

    return _read_regular_bytes(Path(path), where=where)


def atomic_write_bytes(path: str | Path, data: bytes) -> None:
    """Atomically replace *path* with private bytes and durably commit its name.

    The temporary is an unpredictable, same-directory ``0600`` regular file
    opened with ``O_EXCL`` and ``O_NOFOLLOW`` where available.  Its bytes and
    metadata are fsynced before ``os.replace``; the containing directory is
    fsynced afterwards.  Existing symlink or non-regular targets are refused.
    """

    if not isinstance(data, bytes):
        raise BenchArtifactError("atomic write data must be bytes")
    target = Path(path)
    parent_fd = _open_parent_directory(target, create=True, where=f"parent of {target}")
    temporary_name: str | None = None
    descriptor: int | None = None
    try:
        _refuse_nonregular_target(parent_fd, target.name, where=str(target))
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        for _ in range(128):
            candidate = f".{target.name}.{uuid.uuid4().hex}.tmp"
            try:
                descriptor = os.open(candidate, flags, 0o600, dir_fd=parent_fd)
            except FileExistsError:
                continue
            temporary_name = candidate
            break
        if descriptor is None or temporary_name is None:
            raise BenchArtifactError(f"cannot allocate an exclusive temporary for {target}")

        try:
            _write_all(descriptor, data, where=str(target))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
            descriptor = None

        os.replace(
            temporary_name,
            target.name,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
        )
        temporary_name = None
        os.fsync(parent_fd)
    except BenchArtifactError:
        raise
    except OSError as error:
        raise BenchArtifactError(f"cannot atomically write {target}: {error}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary_name is not None:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            except OSError:
                # Preserve the primary failure. An uncommitted random 0600
                # temporary is discoverable by bundle inventory validation.
                pass
        os.close(parent_fd)


def append_jsonl(path: str | Path, value: Any, *, where: str) -> None:
    """Append one canonical JSON object plus LF and fsync before returning."""

    if not isinstance(value, dict):
        raise BenchArtifactError(f"{where} JSONL record must be an object")
    line = canonical_json_bytes(value, where=where) + b"\n"
    target = Path(path)
    process_lock = _append_lock(target)
    with process_lock:
        parent_fd = _open_parent_directory(target, create=True, where=f"parent of {target}")
        descriptor: int | None = None
        try:
            existed = _entry_exists(parent_fd, target.name)
            _refuse_nonregular_target(parent_fd, target.name, where=str(target))
            flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(target.name, flags, 0o600, dir_fd=parent_fd)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise BenchArtifactError(f"{where} journal must be an unlinked regular file")
            _write_all(descriptor, line, where=where)
            os.fsync(descriptor)
            if not existed:
                os.fsync(parent_fd)
        except BenchArtifactError:
            raise
        except OSError as error:
            raise BenchArtifactError(f"cannot append {where}: {error}") from error
        finally:
            if descriptor is not None:
                os.close(descriptor)
            os.close(parent_fd)


def sha256_bytes(data: bytes) -> str:
    """Return the lowercase SHA-256 digest of exact bytes."""

    if not isinstance(data, bytes):
        raise BenchArtifactError("sha256 input must be bytes")
    return hashlib.sha256(data).hexdigest()


def ensure_safe_bundle_root(path: str | Path) -> Path:
    """Create or verify a nonsymlink local bundle directory and return it absolute.

    Every existing component is checked with ``lstat``.  This intentionally
    rejects paths routed through symlinked ancestors: evidence containment must
    be a filesystem fact, not merely the result of normal path resolution.
    """

    raw = os.fspath(path)
    if not raw or "\x00" in raw:
        raise BenchArtifactError("bundle root must be a non-empty filesystem path")
    absolute = Path(os.path.abspath(raw))
    descriptor = _open_directory_chain(absolute, create=True, where="bundle root")
    os.close(descriptor)
    return absolute


def contained_regular_file(
    root: str | Path,
    relative: str | Path,
    *,
    where: str,
) -> Path:
    """Resolve a portable relative name to an existing contained regular file.

    Absolute, empty, dot, parent, Windows drive/UNC, slash-confused, symlinked,
    hard-linked, directory, FIFO, socket, and device targets are rejected.
    """

    root_text = os.fspath(root)
    if not root_text or "\x00" in root_text:
        raise BenchArtifactError("bundle root must be a non-empty filesystem path")
    bundle = Path(os.path.abspath(root_text))
    text = os.fspath(relative)
    if not text or "\x00" in text or "\\" in text:
        raise BenchArtifactError(f"{where} path is not a portable relative path")
    posix = PurePosixPath(text)
    windows = PureWindowsPath(text)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.drive
        or not posix.parts
        or any(part == "" for part in text.split("/"))
        or any(part in {"", ".", ".."} for part in posix.parts)
    ):
        raise BenchArtifactError(f"{where} path is not a contained relative path")

    candidate = bundle.joinpath(*posix.parts)
    directory_fd = _open_directory_chain(bundle, create=False, where="bundle root")
    try:
        for index, part in enumerate(posix.parts):
            if index < len(posix.parts) - 1:
                flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
                next_fd = os.open(part, flags, dir_fd=directory_fd)
                info = os.fstat(next_fd)
                if not stat.S_ISDIR(info.st_mode):
                    os.close(next_fd)
                    raise BenchArtifactError(f"{where} parent must be a directory")
                os.close(directory_fd)
                directory_fd = next_fd
                continue
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            file_descriptor = os.open(part, flags, dir_fd=directory_fd)
            try:
                info = os.fstat(file_descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise BenchArtifactError(f"{where} must be a single-link regular file")
            finally:
                os.close(file_descriptor)
    except FileNotFoundError as error:
        raise BenchArtifactError(f"{where} file is missing") from error
    except OSError as error:
        raise BenchArtifactError(f"cannot inspect {where}: {error}") from error
    finally:
        os.close(directory_fd)
    return candidate


class CampaignLock:
    """Lifetime nonblocking exclusive lock for one local campaign directory.

    ``path`` names a durable marker inside the campaign, while the advisory
    lock itself is held on the containing directory inode.  Locking the stable
    directory anchor prevents unlinking/replacing the marker from creating a
    second independently lockable inode.  Importing this module remains safe
    on platforms without ``fcntl``; acquisition then raises
    ``LockUnavailable``.  The object supports explicit ``acquire``/``release``
    and context-manager use.  Release is idempotent.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._descriptor: int | None = None
        self._fcntl: Any = None
        self._depth = 0
        self._guard = threading.Lock()

    def acquire(self) -> CampaignLock:
        with self._guard:
            if self._descriptor is not None:
                self._depth += 1
                return self
            try:
                import fcntl
            except ImportError as error:
                raise LockUnavailable("evidence campaign locking requires Unix fcntl") from error
            if fcntl is None or not hasattr(fcntl, "flock"):
                raise LockUnavailable("evidence campaign locking requires Unix fcntl")

            directory_fd = _open_parent_directory(
                self.path,
                create=True,
                where=f"parent of lock {self.path}",
            )
            marker_fd: int | None = None
            try:
                try:
                    fcntl.flock(directory_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise RunLocked(f"another writer owns campaign {self.path.parent}") from error
                except OSError as error:
                    if error.errno in {errno.EACCES, errno.EAGAIN}:
                        raise RunLocked(
                            f"another writer owns campaign {self.path.parent}"
                        ) from error
                    raise

                _refuse_nonregular_target(directory_fd, self.path.name, where=str(self.path))
                flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
                marker_fd = os.open(self.path.name, flags, 0o600, dir_fd=directory_fd)
                info = os.fstat(marker_fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise BenchArtifactError("campaign lock must be a single-link regular file")
                os.close(marker_fd)
                marker_fd = None
                os.fsync(directory_fd)
                self._descriptor = directory_fd
                self._fcntl = fcntl
                self._depth = 1
                directory_fd = -1
                return self
            except (BenchArtifactError, RunLocked):
                raise
            except OSError as error:
                raise BenchArtifactError(f"cannot acquire campaign lock: {error}") from error
            finally:
                if marker_fd is not None:
                    os.close(marker_fd)
                if directory_fd >= 0:
                    os.close(directory_fd)

    def release(self) -> None:
        with self._guard:
            descriptor = self._descriptor
            if descriptor is None:
                return
            if self._depth > 1:
                self._depth -= 1
                return
            self._descriptor = None
            self._depth = 0
            fcntl = self._fcntl
            self._fcntl = None
            try:
                if fcntl is not None:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)

    def assert_owned(self) -> None:
        """Fail if ``path.parent`` no longer names the locked directory inode.

        Writer I/O is path based.  A campaign directory can be renamed and a
        different directory placed at its old pathname while the original
        directory descriptor remains locked.  Checking the current pathname
        against that descriptor before each I/O boundary prevents the old
        writer from silently mutating the replacement inode.
        """

        with self._guard:
            descriptor = self._descriptor
            if descriptor is None:
                raise BenchArtifactError("evidence campaign lock is not held")
            current_fd = _open_parent_directory(
                self.path,
                create=False,
                where=f"parent of lock {self.path}",
            )
            try:
                held = os.fstat(descriptor)
                current = os.fstat(current_fd)
                if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
                    raise BenchArtifactError(
                        "campaign path no longer identifies the locked directory inode"
                    )
            finally:
                os.close(current_fd)

    def __enter__(self) -> CampaignLock:
        return self.acquire()

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.release()

    def __del__(self) -> None:
        try:
            while self._descriptor is not None:
                self.release()
        except Exception:
            pass


def campaign_lock_is_held(path: str | Path) -> bool:
    """Return whether a writer owns the campaign directory containing *path*.

    The probe takes a nonblocking shared lock on a separately opened directory
    descriptor.  It never creates or trusts the marker file, and immediately
    releases a successful probe.  This is advisory coordination for a reader;
    it is not a substitute for :class:`CampaignLock` around writes.
    """

    try:
        import fcntl
    except ImportError as error:
        raise LockUnavailable("evidence campaign locking requires Unix fcntl") from error
    if fcntl is None or not hasattr(fcntl, "flock"):
        raise LockUnavailable("evidence campaign locking requires Unix fcntl")

    marker = Path(path)
    directory_fd = _open_parent_directory(
        marker,
        create=False,
        where=f"parent of lock {marker}",
    )
    acquired = False
    try:
        try:
            fcntl.flock(directory_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            return True
        except OSError as error:
            if error.errno in {errno.EACCES, errno.EAGAIN}:
                return True
            raise BenchArtifactError(f"cannot probe campaign lock: {error}") from error
        return False
    finally:
        try:
            if acquired:
                fcntl.flock(directory_fd, fcntl.LOCK_UN)
        finally:
            os.close(directory_fd)


def _validate_json(
    value: Any,
    *,
    where: str,
    active: set[int],
    depth: int,
) -> None:
    if depth > _MAX_JSON_DEPTH:
        raise BenchArtifactError(f"{where} exceeds the maximum JSON nesting depth")
    if type(value) not in _JSON_TYPES:
        raise BenchArtifactError(f"{where} contains unsupported JSON type {type(value).__name__}")
    if value is None or isinstance(value, (bool, int)):
        return
    if isinstance(value, str):
        try:
            value.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise BenchArtifactError(f"{where} contains a non-Unicode JSON string") from error
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise BenchArtifactError(f"{where} contains a non-finite JSON number")
        return

    marker = id(value)
    if marker in active:
        raise BenchArtifactError(f"{where} contains cyclic JSON")
    active.add(marker)
    try:
        if isinstance(value, list):
            for index, item in enumerate(value):
                _validate_json(
                    item,
                    where=f"{where}[{index}]",
                    active=active,
                    depth=depth + 1,
                )
            return
        assert isinstance(value, dict)
        for key, item in value.items():
            if not isinstance(key, str):
                raise BenchArtifactError(f"{where} JSON object keys must be strings")
            try:
                key.encode("utf-8", errors="strict")
            except UnicodeEncodeError as error:
                raise BenchArtifactError(
                    f"{where} contains a non-Unicode JSON object key"
                ) from error
            _validate_json(
                item,
                where=f"{where}.{key}",
                active=active,
                depth=depth + 1,
            )
    finally:
        active.remove(marker)


def _strict_loads(raw: str, *, where: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise BenchArtifactError(f"{where} contains duplicate JSON key {key!r}")
            result[key] = value
        return result

    def constant(value: str) -> None:
        raise BenchArtifactError(f"{where} contains non-finite JSON number {value}")

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except BenchArtifactError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError, RecursionError) as error:
        raise BenchArtifactError(f"{where} is not strict JSON: {error}") from error


def _read_regular_bytes(path: Path, *, where: str) -> bytes:
    parent_fd = _open_parent_directory(path, create=False, where=f"parent of {where}")
    descriptor: int | None = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path.name, flags, dir_fd=parent_fd)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise BenchArtifactError(f"{where} must be a single-link regular file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    except BenchArtifactError:
        raise
    except OSError as error:
        raise BenchArtifactError(f"cannot read {where}: {error}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent_fd)


def _open_parent_directory(path: Path, *, create: bool, where: str) -> int:
    if not path.name or path.name in {".", ".."}:
        raise BenchArtifactError(f"{where} has an invalid target name")
    parent = Path(os.path.abspath(os.fspath(path.parent)))
    return _open_directory_chain(parent, create=create, where=where)


def _open_directory_chain(path: Path, *, create: bool, where: str) -> int:
    """Open a directory through checked ``openat`` components.

    When ``create`` is true, missing components are created relative to their
    already-open parent, then that parent is fsynced.  No path-based mkdir is
    allowed to follow an unchecked symlink before validation.
    """

    absolute = Path(os.path.abspath(os.fspath(path)))
    parts = absolute.parts
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(parts[0], flags)
        for part in parts[1:]:
            try:
                info = os.stat(part, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o700, dir_fd=descriptor)
                os.fsync(descriptor)
                info = os.stat(part, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise BenchArtifactError(f"{where} must not traverse a non-directory or symlink")
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except BenchArtifactError:
        if "descriptor" in locals():
            os.close(descriptor)
        raise
    except FileNotFoundError as error:
        if "descriptor" in locals():
            os.close(descriptor)
        raise BenchArtifactError(f"{where} directory is missing") from error
    except OSError as error:
        if "descriptor" in locals():
            os.close(descriptor)
        raise BenchArtifactError(f"cannot inspect {where}: {error}") from error


def _entry_exists(parent_fd: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return True


def _refuse_nonregular_target(parent_fd: int, name: str, *, where: str) -> None:
    try:
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise BenchArtifactError(f"{where} target must be a single-link regular file")


def _write_all(descriptor: int, data: bytes, *, where: str) -> None:
    view = memoryview(data)
    written = 0
    while written < len(view):
        count = os.write(descriptor, view[written:])
        if count <= 0:
            raise BenchArtifactError(f"short write while persisting {where}")
        written += count


def _append_lock(path: Path) -> threading.Lock:
    key = os.path.abspath(os.fspath(path))
    with _APPEND_LOCKS_GUARD:
        lock = _APPEND_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _APPEND_LOCKS[key] = lock
        return lock


__all__ = [
    "CampaignLock",
    "append_jsonl",
    "atomic_write_bytes",
    "campaign_lock_is_held",
    "canonical_json_bytes",
    "contained_regular_file",
    "ensure_safe_bundle_root",
    "read_regular_bytes",
    "sha256_bytes",
    "strict_load_json",
    "strict_load_jsonl",
]
