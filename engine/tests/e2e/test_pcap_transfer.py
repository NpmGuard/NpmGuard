# SCENARIO MAP — the pcap sensor's transfer out of a REAL container, after the
# `base64 -w0` hop was dropped from sensors.stop_pcap. Sibling of
# test_docker_transfer.py (S45-S47), which pins the seam itself; this file pins the
# CALL SITE and the structural claim the seam's cap now rests on.
#
# THE CLAIM: with the capture fetched RAW, an over-cap transfer of a WHOLE capture
# is unrepresentable rather than merely loud. tcpdump writes the capture to the
# container's /tmp — a tmpfs of docker.SANDBOX_TMP_MB — and the transfer cap is no
# smaller, so the file cannot outgrow what one transfer carries. `base64 -w0`'s 4/3
# inflation was the last thing that broke it: a 13,002,771-byte capture arrived as
# a 7,864,320-byte prefix and was sealed as pcapHash with error=null (67f830f).
#
# Axes: transfer volume against the cap (at the boundary / a real capture) ×
#       encoding (raw / base64) × what is compared (byte count, sha256, L2 events)
#   S48 the BOUNDARY, measured rather than argued: one writer filling the sandbox
#       /tmp produces a file of exactly MAX_EXEC_OUTPUT_BYTES, which transfers
#       whole and sha256-identical — while `base64 -w0` of that same file raises
#       DockerOutputTooLargeError. The 4/3 inflation is the only difference
#   S49 a REAL capture through the real sensor: start_pcap, ~2 MB of loopback HTTP
#       traffic, stop_pcap. The bytes stop_pcap returns match the container's own
#       stat and hash to its own sha256sum — which is what makes observation.py's
#       "pcapHash is the hash of the WHOLE capture" true rather than claimed. S45
#       proves the reader and S47 proves a hash is sealed; neither proves the sealed
#       hash is the capture's
#
# S48 writes 64 MiB to a tmpfs and reads it back twice; that is the price of
# measuring the boundary instead of asserting it from two constants (the constants
# are checked in tests/test_sensors.py C12b).

from __future__ import annotations

import hashlib
from uuid import uuid4

import pytest

from npmguard.config import Settings
from npmguard.docker import (
    MAX_EXEC_OUTPUT_BYTES,
    DockerOutputTooLargeError,
    default_container_spec,
    docker_exec,
    read_bytes_from_container,
    spec_to_docker_args,
    write_file_in_container,
)
from npmguard.sensors import PCAP_FILE, start_pcap, stop_pcap

pytestmark = [pytest.mark.e2e, pytest.mark.docker]

# 2 MiB pushed over loopback in 64 KiB writes, so the capture is megabytes rather
# than kilobytes — the size class that used to arrive silently prefixed. Loopback
# only, so the volume does not depend on any host being reachable (the container
# runs with --network=none).
#
# The volume is load-bearing, measured on this sandbox: this script yields a
# 2,025,357-byte capture (tcpdump: 80 packets captured of 178 received by filter),
# while a single 64 KiB request yields a 24-byte capture — the pcap file HEADER and
# nothing else (0 of 26 captured). Which packets the sandbox's tcpdump manages to
# write is host-dependent, so S49 asserts about the BYTES and never about their
# contents; the parse itself is covered by test_sensors.py C8/C8b over committed
# tshark captures.
TRAFFIC_JS = """
const http = require('http');
const CHUNK = Buffer.alloc(64 * 1024, 0x41);
const CHUNKS = 32;
const server = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => { res.end('ok'); });
});
server.listen(9101, '127.0.0.1', () => {
  const request = http.request(
    { host: '127.0.0.1', port: 9101, method: 'POST', path: '/sink' },
    (res) => { res.on('data', () => {}); res.on('end', () => server.close()); },
  );
  for (let index = 0; index < CHUNKS; index += 1) request.write(CHUNK);
  request.end();
});
"""


async def _container(**changes) -> str:
    spec = default_container_spec(Settings(_env_file=None), network_mode="none", **changes)
    name = f"npmguard-pcap-{uuid4().hex[:10]}"
    start = await docker_exec(spec_to_docker_args(spec, name), 60_000)
    assert start.exit_code == 0, start.stderr
    return name


@pytest.fixture
async def plain_container():
    name = await _container()
    try:
        yield name
    finally:
        await docker_exec(["rm", "-f", name], 30_000)


@pytest.fixture
async def capturing_container():
    # The capabilities observation.py adds when it observes the network: tcpdump
    # needs NET_RAW to open the capture socket and SETUID/SETGID for `-Z root`.
    name = await _container(cap_add=["NET_RAW", "SETUID", "SETGID"])
    try:
        yield name
    finally:
        await docker_exec(["rm", "-f", name], 30_000)


async def test_a_file_that_fills_the_sandbox_tmp_still_transfers_whole(plain_container) -> None:
    """S48: the boundary case, measured. `head -c 100MB` into the 64 MiB /tmp stops
    at ENOSPC, leaving a file of exactly MAX_EXEC_OUTPUT_BYTES — the largest whole
    sensor file the sandbox can hold. It transfers raw, complete and byte-identical
    (the cap is a strict `>`), so no whole capture can pass it. Encoded, the same
    file raises: the 4/3 inflation is the entire difference between "loud" and
    "impossible", and it is why sensors.stop_pcap no longer encodes."""
    path = "/tmp/fill.bin"
    written = await docker_exec(
        [
            "exec",
            "--user",
            "0",
            plain_container,
            "sh",
            "-c",
            # ENOSPC makes head exit nonzero; the partial file is the point.
            f"head -c 100000000 /dev/urandom > {path}; stat -c %s {path}; sha256sum {path}",
        ],
        180_000,
    )
    assert written.exit_code == 0, written.stderr
    size_line, digest_line = written.stdout.split("\n")[:2]
    size = int(size_line)
    assert size == MAX_EXEC_OUTPUT_BYTES, "the sandbox /tmp and the transfer cap have drifted apart"

    raw = await read_bytes_from_container(plain_container, path, user="0")
    assert len(raw) == size
    assert hashlib.sha256(raw).hexdigest() == digest_line.split()[0]

    with pytest.raises(DockerOutputTooLargeError):
        await docker_exec(["exec", "--user", "0", plain_container, "base64", "-w0", path], 180_000)


async def test_stop_pcap_returns_the_capture_the_container_holds(capturing_container) -> None:
    """S49: the real sensor over a real megabyte-scale capture. The sha256 of the
    bytes stop_pcap returns is the container's OWN sha256sum of the capture file, and
    the byte count matches its own stat — so `pcapHash` attests the whole capture
    rather than whatever fitted. Nothing proved that before: S45 proves the reader
    and S47 proves a hash is sealed, but not that the sealed hash is the capture's.
    It was false while the transfer went through base64 (a 13,002,771-byte capture
    sealed as a 7,864,320-byte prefix with error=null, i.e. eligible to REFUTE)."""
    await start_pcap(capturing_container)
    await write_file_in_container(capturing_container, "/tmp/traffic.js", TRAFFIC_JS)
    traffic = await docker_exec(["exec", capturing_container, "node", "/tmp/traffic.js"], 60_000)
    assert traffic.exit_code == 0, traffic.stderr

    result = await stop_pcap(capturing_container)
    held = await docker_exec(
        ["exec", "--user", "0", capturing_container, "sh", "-c", f"sha256sum {PCAP_FILE}; stat -c %s {PCAP_FILE}"],
        30_000,
    )
    assert held.exit_code == 0, held.stderr
    digest, size = held.stdout.split()[0], int(held.stdout.split()[-1])
    assert size > 1_000_000, f"the capture is only {size} bytes — this proves nothing about volume"
    assert len(result.raw_pcap) == size
    assert hashlib.sha256(result.raw_pcap).hexdigest() == digest
