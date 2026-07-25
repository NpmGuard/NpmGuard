# SCENARIO MAP — the container→host transfer, against a REAL daemon and a REAL
# packet capture. This tier exists because the defect it pins was invisible to
# every other one: nothing about it is wrong until the bytes are big.
#
# MEASURED AT 67f830f, before the fix — a real run of the S46 package with the
# 10 MiB slice in place:
#     capture bytes in container  : 13,002,771
#     bytes retrieved to the host :  7,864,320   (= 10 MiB of base64, /4*3)
#     sha256 of the real capture  : ad301a63d0cedc43…
#     artifact.pcapHash           : 1bf215952295…   ← the PREFIX, sealed
#     artifact.error              : None            ← eligible to REFUTE
#     'truncated' rows            : 0
# `base64` exited 0 and `b64decode` never complained, because 10 MiB is a
# multiple of 4. That is the whole defect: a bound that silently changes the data
# is indistinguishable from the data.
#
# Axes: transfer encoding (raw / base64) × payload (random binary / a real pcap) ×
#       volume against the cap (fits / passes)
#   S45 a binary file leaves a real container byte-exact with NO encoding hop, and
#       `base64 -w0` of the same file agrees byte-for-byte while costing 4/3 the
#       transfer — so the hop buys nothing and pays the inflation that caused the
#       truncation. This was the evidence for dropping it in sensors.stop_pcap,
#       which has since happened (the boundary it left is e2e/test_pcap_transfer.py)
#   S46 a run whose CAPTURE cannot be transferred whole: pcapHash is null (never a
#       prefix's hash), the error is a SensorError naming the cap, a `truncated`
#       row reaches the timeline, and the L4 evidence collected before the gap is
#       still sealed — so the run can still CONFIRM while the gap bars REFUTED
#   S47 positive control, same package and same traffic with the cap at its real
#       value: the capture transfers whole and pcapHash IS sealed, so S46 is
#       asserting about the cap rather than about a broken run
#
# The cap is moved through the module seam (docker.MAX_EXEC_OUTPUT_BYTES) rather
# than by generating 48 MB of traffic: at the real 64 MiB cap only an ENCODED
# transfer can overflow, since the sandbox's /tmp tmpfs is 64 MiB and bounds every
# sensor file. Which is exactly the property S45 is evidence for.

from __future__ import annotations

import hashlib
from pathlib import Path
from uuid import uuid4

import pytest

from npmguard import docker as docker_module
from npmguard.config import Settings
from npmguard.contract.models import ToolCall
from npmguard.docker import (
    default_container_spec,
    docker_exec,
    read_bytes_from_container,
    spec_to_docker_args,
)
from npmguard.observation import run_under_observation

pytestmark = [pytest.mark.e2e, pytest.mark.docker]

# ~2 MiB pushed over loopback in 64 KiB writes. The resulting capture is what S46
# needs to be BIGGER than the cap it mocks; measured on this sandbox it is
# 2,025,357 bytes (tcpdump wrote 80 of the 178 packets its filter saw), so the
# claim this comment used to make — ">3 MiB" — was not true here, and S46's 2 MiB
# cap only ever overflowed because `base64 -w0` inflated 1.93 MiB to 2.58 MiB. The
# mocked cap is now well under the capture instead (see S46), which is what makes
# the scenario about the CAP rather than about an encoding that no longer happens.
# Loopback only, so the volume does not depend on any remote host.
TRAFFIC_JS = """
const http = require('http');
const CHUNK = Buffer.alloc(64 * 1024, 0x41);
const CHUNKS = 32;
const server = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => { res.end('ok'); });
});
server.listen(9100, '127.0.0.1', () => {
  const request = http.request(
    { host: '127.0.0.1', port: 9100, method: 'POST', path: '/sink' },
    (res) => { res.on('data', () => {}); res.on('end', () => server.close()); },
  );
  for (let index = 0; index < CHUNKS; index += 1) request.write(CHUNK);
  request.end();
});
"""

OBSERVE = {"kernel": False, "network": True, "node": True, "fsDiff": False, "inspector": False}
BUDGET = {"wallMs": 60_000}
TRIGGER = [ToolCall(tool="trigger", args={"kind": "entrypoint", "target": "index.js"})]


@pytest.fixture
def traffic_package(tmp_path: Path) -> Path:
    package = tmp_path / "pkg"
    package.mkdir()
    (package / "package.json").write_text('{"name":"bulk","version":"1.0.0","main":"index.js"}')
    (package / "index.js").write_text(TRAFFIC_JS)
    return package


@pytest.fixture
async def container():
    spec = default_container_spec(Settings(_env_file=None), network_mode="none")
    name = f"npmguard-transfer-{uuid4().hex[:10]}"
    start = await docker_exec(spec_to_docker_args(spec, name), 60_000)
    assert start.exit_code == 0, start.stderr
    try:
        yield name
    finally:
        await docker_exec(["rm", "-f", name], 30_000)


async def test_binary_transfer_is_exact_and_base64_adds_nothing(container) -> None:
    """S45: 8 MiB of /dev/urandom out of a real container. The raw transfer's
    sha256 equals the container's own sha256sum, so `docker exec cat` is
    byte-exact with no TTY translation and nothing to decode. The base64 hop
    agrees byte-for-byte — it adds no fidelity, only a 4/3 inflation against the
    transfer cap, which is what silently prefixed a 13 MB capture at 7.5 MiB."""
    path = "/tmp/urandom.bin"
    written = await docker_exec(
        [
            "exec",
            "--user",
            "0",
            container,
            "sh",
            "-c",
            f"head -c 8388608 /dev/urandom > {path} && sha256sum {path}",
        ],
        60_000,
    )
    assert written.exit_code == 0, written.stderr
    expected = written.stdout.split()[0]

    raw = await read_bytes_from_container(container, path, user="0")
    assert len(raw) == 8 * 1024 * 1024
    assert hashlib.sha256(raw).hexdigest() == expected

    encoded = await docker_exec(["exec", "--user", "0", container, "base64", "-w0", path], 60_000)
    assert encoded.exit_code == 0
    import base64 as base64_module

    assert base64_module.b64decode(encoded.stdout) == raw
    # The cost of the hop, stated as a number rather than a claim.
    assert len(encoded.stdout) == 4 * (len(raw) // 3 + 1)


async def test_capture_over_the_cap_defers_and_seals_no_hash(
    traffic_package, monkeypatch
) -> None:
    """S46: the real thing — real tcpdump, a real >3 MiB capture, a real transfer
    that cannot complete. No pcapHash is sealed, the SensorError names the cap
    (routing to DEFERRED, so this run can never be SAFE), a `truncated` row is in
    the timeline, and the L4 network evidence captured before the gap is still
    there, which is what keeps a real exfiltration confirmable."""
    # 512 KiB, comfortably under the ~2 MB this package's traffic captures. It was
    # 2 MiB, which passed for the wrong reason: the capture measured 2,025,357 bytes,
    # so the RAW transfer fitted and only base64's 4/3 inflation (2,700,476 bytes)
    # passed the cap. sensors.stop_pcap no longer encodes, so at 2 MiB this run now
    # transfers whole and seals a pcapHash — verified, which is how this line came to
    # move. A cap below the capture makes the gap independent of the encoding.
    monkeypatch.setattr(docker_module, "MAX_EXEC_OUTPUT_BYTES", 512 * 1024)
    artifact = await run_under_observation(
        traffic_package, TRIGGER, Settings(_env_file=None), observe=OBSERVE, budget=BUDGET
    )
    assert artifact.pcapHash is None
    assert artifact.error is not None
    assert artifact.error.kind == "SensorError"
    assert "transfer cap" in artifact.error.detail
    assert any(event.kind == "truncated" for event in artifact.events)
    assert any(event.stream == "L4:monkey" for event in artifact.events)
    assert artifact.exitCode == 0 and artifact.timedOut is False


async def test_capture_that_fits_still_seals_its_hash(traffic_package) -> None:
    """S47: the same package and the same traffic at the real cap. The capture
    transfers whole and pcapHash is sealed with no error — so S46 pins the cap,
    not a package that cannot be observed."""
    artifact = await run_under_observation(
        traffic_package, TRIGGER, Settings(_env_file=None), observe=OBSERVE, budget=BUDGET
    )
    assert artifact.error is None, artifact.error
    assert artifact.pcapHash is not None
    assert not any(event.kind == "truncated" for event in artifact.events)
