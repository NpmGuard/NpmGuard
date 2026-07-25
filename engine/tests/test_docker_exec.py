# CLASS MAP — docker_exec, the container→host transfer seam (the ONE place a
# stream crosses from a run into the engine, and therefore the one place a
# truncation can turn evidence into a lie)
#
# Seam: a stand-in `docker` executable on PATH. What these classes are about is
# the engine-side stream accounting — how many bytes are kept, when a process is
# killed, what is returned versus raised — so the producer only has to produce
# bytes. The claim that DOCKER ITSELF streams bytes faithfully is not testable
# here and is proven against the real daemon in tests/e2e/test_docker_transfer.py
# (S45). The cap is moved through the module seam (MAX_EXEC_OUTPUT_BYTES) rather
# than injected, per TESTING.md: the numeric value is not what any class asserts.
#
# Axes: output volume (under cap / exactly at cap / over cap) × which stream ×
#       process outcome (exit 0 / nonzero / never exits) × stdin present ×
#       payload (text / binary)
#   C1 output under the cap round-trips COMPLETE on both streams, exit code kept
#   C2 output exactly AT the cap is complete — the bound is "passed", not
#      "reached", so a file of exactly the cap size still transfers whole
#   C3 stdout PAST the cap raises DockerOutputTooLargeError naming the stream,
#      the bytes read, the cap and the command — it never returns the prefix
#      that fits. THE DEFECT: 12 MiB of stdout came back as exactly 10 MiB with
#      exit_code 0, and callers hashed that prefix as the whole capture
#   C4 stderr past the cap raises the same way (stderrHash is sealed evidence
#      too, so a prefixed stderr is the same false attestation)
#   C5 a process that never exits is killed at the wall-clock timeout, reports
#      timed_out=True, and KEEPS what was written before the kill — the one
#      short read that is not silent, because timedOut lands in the artifact
#   C6 stdin is delivered and its echo returned
#   C7 nonzero exit + stderr are REPORTED, not raised
#   C8 the cap is a real resource bound: an endlessly flooding process is killed
#      as soon as the cap is passed, not drained, and leaves no pending task
#      behind. (Before, `communicate()` buffered the WHOLE stream and the 10 MiB
#      slice was applied to the complete copy afterwards — so the "limit"
#      bounded nothing and only shortened what the caller hashed.)
#   C9 binary bytes reach the engine byte-exact with no encoding hop and no
#      decode (read_bytes_from_container), and the text reader is that reader
#      plus a decode
#  C10 the sandbox /tmp size and the transfer cap are one coupling, not two
#      numbers: the container spec renders SANDBOX_TMP_MB, and the import-time
#      assert in docker.py keeps it under the cap so a WHOLE sensor file always
#      fits (only an encoding hop can inflate past it)
from __future__ import annotations

import asyncio
import hashlib
import secrets
import stat
from pathlib import Path

import pytest

from npmguard import docker as docker_module
from npmguard.docker import (
    MAX_EXEC_OUTPUT_BYTES,
    SANDBOX_TMP_MB,
    DockerOutputTooLargeError,
    default_container_spec,
    docker_exec,
    read_bytes_from_container,
    read_file_in_container,
    spec_to_docker_args,
)

# The stand-in producer. `exec` in the hang/flood/cat arms replaces the shell, so
# killing the child closes the pipe instead of leaving a grandchild holding it.
STUB_DOCKER = """#!/bin/sh
mode="$1"
shift
case "$mode" in
  emit)      head -c "$1" /dev/zero ;;
  emit_err)  head -c "$1" /dev/zero >&2 ;;
  both)      head -c "$1" /dev/zero; head -c "$2" /dev/zero >&2 ;;
  flood)     exec cat /dev/zero ;;
  hang)      head -c 64 /dev/zero; exec sleep 30 ;;
  fail)      printf 'stub refused\\n' >&2; exit "$1" ;;
  exec)      for last in "$@"; do :; done; exec cat "$last" ;;
esac
"""


@pytest.fixture
def stub_docker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    binary = tmp_path / "bin"
    binary.mkdir()
    stub = binary / "docker"
    stub.write_text(STUB_DOCKER)
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{binary}:{Path('/usr/bin')}:{Path('/bin')}")
    return tmp_path


def _cap(monkeypatch: pytest.MonkeyPatch, value: int) -> int:
    monkeypatch.setattr(docker_module, "MAX_EXEC_OUTPUT_BYTES", value)
    return value


async def test_streams_under_the_cap_round_trip_complete(stub_docker, monkeypatch) -> None:
    """C1: both streams arrive whole, with the exit code, when nothing is near the
    cap — the case every existing caller depends on."""
    _cap(monkeypatch, 1024 * 1024)
    result = await docker_exec(["both", "5000", "700"], 20_000)
    assert (len(result.stdout), len(result.stderr)) == (5000, 700)
    assert (result.exit_code, result.timed_out) == (0, False)


async def test_output_exactly_at_the_cap_is_complete(stub_docker, monkeypatch) -> None:
    """C2: the bound is PASSED the cap, not reached. A file of exactly the cap
    size must still transfer whole, or the cap would itself become a source of
    prefixes at the boundary it exists to protect."""
    cap = _cap(monkeypatch, 64 * 1024)
    result = await docker_exec(["emit", str(cap)], 20_000)
    assert len(result.stdout) == cap
    assert result.exit_code == 0


async def test_stdout_past_the_cap_raises_instead_of_returning_a_prefix(
    stub_docker, monkeypatch
) -> None:
    """C3: THE DEFECT. The old seam sliced stdout at 10 MiB and returned it with
    exit_code 0, so `base64 -w0` of a 13 MB pcap arrived as a 7.5 MiB prefix —
    a multiple of 4, so b64decode never complained — and was hashed into
    pcapHash as the complete capture. Nothing may hand a caller a prefix: the
    error names the stream, the bytes read, the cap and the command."""
    cap = _cap(monkeypatch, 64 * 1024)
    with pytest.raises(DockerOutputTooLargeError) as raised:
        await docker_exec(["emit", str(cap + 1024)], 20_000)
    assert raised.value.stream == "stdout"
    assert raised.value.cap == cap
    assert raised.value.read_bytes > cap
    message = str(raised.value)
    assert "stdout" in message and str(cap) in message and "emit" in message


async def test_stderr_past_the_cap_raises_too(stub_docker, monkeypatch) -> None:
    """C4: stderr is sealed evidence as well (stderrHash), and it is what every
    failure detail quotes — so a prefixed stderr is the same false attestation
    as a prefixed stdout, and gets the same refusal."""
    cap = _cap(monkeypatch, 64 * 1024)
    with pytest.raises(DockerOutputTooLargeError) as raised:
        await docker_exec(["emit_err", str(cap * 2)], 20_000)
    assert raised.value.stream == "stderr"


async def test_timeout_keeps_what_was_written_before_the_kill(stub_docker, monkeypatch) -> None:
    """C5: the ONE short read that is not silent. A process that never exits is
    killed at the budget; timed_out=True lands in the artifact (plus a
    `truncated` timeline row), and the bytes written before the kill are kept —
    discarding them would lose the partial L4 trace of a hung run."""
    _cap(monkeypatch, 1024 * 1024)
    result = await docker_exec(["hang"], 700)
    assert result.timed_out is True
    assert result.exit_code == -1
    assert len(result.stdout) == 64


async def test_stdin_is_delivered(stub_docker, monkeypatch) -> None:
    """C6: the trigger pipes stdin through this seam (`docker exec -i`), so a
    payload must arrive and its echo come back."""
    _cap(monkeypatch, 1024 * 1024)
    payload = b"kQ29-stdin-payload\n"
    (stub_docker / "input.bin").write_bytes(payload)
    result = await docker_exec(["exec", "c", "cat", str(stub_docker / "input.bin")], 20_000)
    assert result.stdout.encode() == payload


async def test_nonzero_exit_is_reported_not_raised(stub_docker, monkeypatch) -> None:
    """C7: a failed exec is data — every caller branches on exit_code and quotes
    stderr. Only a stream that cannot be retrieved WHOLE raises."""
    _cap(monkeypatch, 1024 * 1024)
    result = await docker_exec(["fail", "3"], 20_000)
    assert result.exit_code == 3
    assert "stub refused" in result.stderr
    assert result.timed_out is False


async def test_flood_is_killed_at_the_cap_and_leaves_nothing_running(
    stub_docker, monkeypatch
) -> None:
    """C8: the cap is a resource bound, not a slice. An endless producer is killed
    as soon as it passes the cap — so this returns in well under the exec budget
    rather than draining /dev/zero — and no reader task outlives the call. The
    old seam let `communicate()` buffer the ENTIRE stream and applied its 10 MiB
    slice to the finished copy, which bounded nothing at all."""
    _cap(monkeypatch, 512 * 1024)
    before = asyncio.all_tasks()
    started = asyncio.get_running_loop().time()
    with pytest.raises(DockerOutputTooLargeError):
        await docker_exec(["flood"], 30_000)
    assert asyncio.get_running_loop().time() - started < 10
    assert {task for task in asyncio.all_tasks() if task not in before} == set()


async def test_binary_transfer_is_byte_exact_and_text_is_a_decode_of_it(
    stub_docker, monkeypatch
) -> None:
    """C9: binary evidence reaches the engine with no encoding hop and no decode,
    so a pcap needs neither base64 (a 4/3 inflation against the cap) nor a
    lossy `errors="replace"` pass. The text reader is this reader plus a decode,
    so there is one transfer path rather than two."""
    _cap(monkeypatch, 8 * 1024 * 1024)
    blob = secrets.token_bytes(3 * 1024 * 1024)
    target = stub_docker / "capture.bin"
    target.write_bytes(blob)
    fetched = await read_bytes_from_container("c", str(target), user="0")
    assert hashlib.sha256(fetched).hexdigest() == hashlib.sha256(blob).hexdigest()
    text = await read_file_in_container("c", str(target))
    assert text == blob.decode(errors="replace")


async def test_a_cancelled_call_leaves_no_process_and_no_task(stub_docker, monkeypatch) -> None:
    """C11: the shutdown path. A worker cancelled mid-exec (graceful shutdown, the
    per-hypothesis timeout) must leave neither a running docker client nor a
    reader task holding a pipe — observation.py's own pre-try cancellation
    handling exists for the same reason, and it cannot clean up what this seam
    abandons. The leaked-descriptor half is enforced by pytest's
    filterwarnings=error: an unclosed pipe transport surfaces as a
    ResourceWarning at collection and fails the run."""
    _cap(monkeypatch, 1024 * 1024)
    before = asyncio.all_tasks()
    call = asyncio.ensure_future(docker_exec(["hang"], 30_000))
    await asyncio.sleep(0.2)
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    await asyncio.sleep(0.1)
    assert {task for task in asyncio.all_tasks() if task not in before and task is not call} == set()


def test_sandbox_tmp_size_and_the_cap_are_one_coupling() -> None:
    """C10: the sandbox /tmp is defined once and rendered into the container from
    SANDBOX_TMP_MB, and docker.py asserts at import that it fits under the
    transfer cap. That is what makes DockerOutputTooLargeError mean "an encoding
    hop inflated the transfer" or "a process is flooding a pipe" — never "a
    complete sensor file was too big to fetch"."""
    from npmguard.config import Settings

    rendered = spec_to_docker_args(default_container_spec(Settings(_env_file=None)), "c")
    assert f"/tmp:rw,noexec,nosuid,size={SANDBOX_TMP_MB}m" in rendered
    assert SANDBOX_TMP_MB * 1024 * 1024 <= MAX_EXEC_OUTPUT_BYTES
