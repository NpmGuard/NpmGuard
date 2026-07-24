"""Repo file access for the panel.

A port of the TS engine's ``github/content.ts``. Two access paths, kept
strictly separate:

- **Authenticated contents API** (installation client) —
  :func:`find_root_lockfile`, :func:`fetch_lockfile`, :func:`fetch_manifest`.
  Files >1 MB come back from GitHub without inline content (``encoding:"none"``)
  — big monorepo ``package-lock.json`` routinely exceed that — so those fall
  back to the git blob API.
- **Anonymous public raw host** — :func:`fetch_public_repo_inputs`. One
  credential-free contents listing to locate the files, then the bytes are
  pulled from ``raw.githubusercontent.com`` **only**, redirects disabled, with
  a streamed 20 MB cap. The client carries no auth, so private content is
  unreachable; the host allow-list is the SSRF boundary.

The ``octo`` argument is a ``githubkit`` :class:`~githubkit.GitHub` client.
Responses are consumed via ``.json()`` (raw dict/list) to stay robust to
githubkit's typed-model shapes.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass

import httpx
from githubkit.exception import RequestFailed

from npmguard.panel.lockfile import LOCKFILE_CANDIDATES

MAX_PUBLIC_REPO_FILE_BYTES = 20 * 1024 * 1024
_RAW_HOST = "raw.githubusercontent.com"
DEFAULT_RAW_BASE = f"https://{_RAW_HOST}"


@dataclass(frozen=True, slots=True)
class FetchedFile:
    path: str
    sha: str
    content: str


@dataclass(frozen=True, slots=True)
class RootLockfile:
    path: str
    sha: str


@dataclass(frozen=True, slots=True)
class PublicRepoInputs:
    lockfile: FetchedFile
    manifest: dict | None


class PublicRepoFileTooLargeError(Exception):
    def __init__(self, path: str) -> None:
        super().__init__(f"{path} exceeds the 20 MB public-audit file limit")
        self.path = path


# --- pure helpers (unit-tested) ---------------------------------------------


def is_inline_base64(entry: dict) -> bool:
    """Whether a contents-API file entry carries decodable inline content.

    ``True`` → decode ``entry['content']`` directly. ``False`` → the file is
    too large for inline content (``encoding:"none"``) and needs the git blob
    fallback.
    """
    return bool(entry.get("content")) and entry.get("encoding") == "base64"


def decode_base64_content(b64: str) -> str:
    """Decode base64 file content (GitHub wraps it at 60 cols) → UTF-8 text."""
    return base64.b64decode(b64).decode("utf-8")


def validate_raw_url(
    download_url: str | None, path: str, *, allowed_base: str | None = None
) -> httpx.URL:
    """Validate a GitHub-supplied download URL against the SSRF boundary.

    Only a URL on the allowed raw-host origin is permitted; anything else (or a
    missing URL) raises. This is what keeps a public-repo audit from being
    redirected at an internal host. ``allowed_base`` defaults to
    ``https://raw.githubusercontent.com`` (production); a test points it at the
    GitHub stub's origin. Scheme, host, and port must all match — a bare https
    base has port ``None`` (implicit 443), so prod stays locked to 443.
    """
    if not download_url:
        raise ValueError(f"GitHub did not provide a download URL for {path}")
    base = httpx.URL(allowed_base or DEFAULT_RAW_BASE)
    url = httpx.URL(download_url)
    if (url.scheme, url.host, url.port) != (base.scheme, base.host, base.port):
        raise ValueError(f"GitHub returned an unsafe download URL for {path}")
    return url


def _get_content_kwargs(ref: str | None) -> dict:
    return {"ref": ref} if ref else {}


async def _get_content_json(octo, owner: str, repo: str, path: str, ref: str | None):
    """``GET /repos/{owner}/{repo}/contents/{path}`` → parsed JSON, or None on 404."""
    try:
        resp = await octo.rest.repos.async_get_content(
            owner, repo, path, **_get_content_kwargs(ref)
        )
    except RequestFailed as err:
        if err.response.status_code == 404:
            return None
        raise
    return resp.json()


# --- authenticated contents API ---------------------------------------------


async def find_root_lockfile(
    octo, owner: str, repo: str, ref: str | None = None
) -> RootLockfile | None:
    """Detect a supported root lockfile without downloading it.

    One contents listing of the repo root; the first
    :data:`~npmguard.panel.lockfile.LOCKFILE_CANDIDATES` entry present wins.
    Used by the dashboard's cached auditability filter — cheaper than probing
    each candidate file individually.
    """
    data = await _get_content_json(octo, owner, repo, "", ref)
    if not isinstance(data, list):
        return None
    for candidate in LOCKFILE_CANDIDATES:
        for item in data:
            if item.get("type") == "file" and item.get("name") == candidate:
                return RootLockfile(path=item["path"], sha=item["sha"])
    return None


async def fetch_repo_file(
    octo, owner: str, repo: str, path: str, ref: str | None = None
) -> FetchedFile | None:
    """Fetch one repo file's content, falling back to the git blob API >1 MB."""
    data = await _get_content_json(octo, owner, repo, path, ref)
    if data is None or isinstance(data, list) or data.get("type") != "file":
        return None

    if is_inline_base64(data):
        return FetchedFile(
            path=path, sha=data["sha"], content=decode_base64_content(data["content"])
        )
    # Files >1 MB arrive without inline content — fetch the blob by sha.
    blob = (await octo.rest.git.async_get_blob(owner, repo, data["sha"])).json()
    return FetchedFile(
        path=path, sha=data["sha"], content=decode_base64_content(blob["content"])
    )


async def fetch_lockfile(
    octo, owner: str, repo: str, ref: str | None = None
) -> FetchedFile | None:
    """The first supported lockfile found at the repo root, or None."""
    for candidate in LOCKFILE_CANDIDATES:
        file = await fetch_repo_file(octo, owner, repo, candidate, ref)
        if file:
            return file
    return None


async def fetch_manifest(
    octo, owner: str, repo: str, ref: str | None = None
) -> dict | None:
    """The parsed root ``package.json``, or None when absent/unparseable."""
    file = await fetch_repo_file(octo, owner, repo, "package.json", ref)
    if not file:
        return None
    try:
        parsed = json.loads(file.content)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


# --- anonymous public raw host ----------------------------------------------


async def _download_public_root_file(entry: dict, *, raw_base: str | None = None) -> str:
    """Stream a public-repo root file from the raw host, capped at 20 MB."""
    url = validate_raw_url(
        entry.get("download_url"),
        entry.get("path", entry.get("name", "?")),
        allowed_base=raw_base,
    )
    path = entry.get("path", "?")
    async with (
        httpx.AsyncClient(follow_redirects=False) as client,
        client.stream("GET", url) as resp,
    ):
        if resp.status_code != 200:
            raise ValueError(f"GitHub raw download failed ({resp.status_code})")
        declared = resp.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > MAX_PUBLIC_REPO_FILE_BYTES:
            raise PublicRepoFileTooLargeError(path)
        chunks: list[bytes] = []
        received = 0
        async for chunk in resp.aiter_bytes():
            received += len(chunk)
            if received > MAX_PUBLIC_REPO_FILE_BYTES:
                raise PublicRepoFileTooLargeError(path)
            chunks.append(chunk)
    return b"".join(chunks).decode("utf-8")


async def fetch_public_repo_inputs(
    octo, owner: str, repo: str, ref: str | None = None, *, raw_base: str | None = None
) -> PublicRepoInputs | None:
    """Fetch a public repo's root lockfile (+ manifest) with no credentials.

    One anonymous contents listing to locate the files, then the bytes pulled
    from ``raw.githubusercontent.com`` only. Returns None when the repo is
    absent or has no supported root lockfile. A malformed ``package.json`` does
    not invalidate a parseable lockfile — the manifest is best-effort.
    """
    data = await _get_content_json(octo, owner, repo, "", ref)
    if not isinstance(data, list):
        return None

    lockfile_entry: dict | None = None
    for candidate in LOCKFILE_CANDIDATES:
        for item in data:
            if item.get("type") == "file" and item.get("name") == candidate:
                lockfile_entry = item
                break
        if lockfile_entry:
            break
    if lockfile_entry is None:
        return None

    manifest_entry = next(
        (
            item
            for item in data
            if item.get("type") == "file" and item.get("name") == "package.json"
        ),
        None,
    )

    lockfile_content = await _download_public_root_file(lockfile_entry, raw_base=raw_base)
    manifest: dict | None = None
    if manifest_entry is not None:
        try:
            manifest_content = await _download_public_root_file(
                manifest_entry, raw_base=raw_base
            )
            parsed = json.loads(manifest_content)
            if isinstance(parsed, dict):
                manifest = parsed
        except (ValueError, TypeError, PublicRepoFileTooLargeError):
            # A malformed / oversized package.json doesn't sink a good lockfile.
            manifest = None

    return PublicRepoInputs(
        lockfile=FetchedFile(
            path=lockfile_entry["path"],
            sha=lockfile_entry["sha"],
            content=lockfile_content,
        ),
        manifest=manifest,
    )
