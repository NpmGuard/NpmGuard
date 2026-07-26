"""The sole producer of benchmark runs.

The runner submits through the ordinary operator audit route, so benchmark work
shares the engine's admission and capacity controls. Queue-full responses are
back-pressure, not observations about detection quality. A dirty engine tree,
mock model, or unidentified sandbox image makes a run unpublishable and is
refused.

Corpus fixtures can be live malware. This module checks directory existence but
never reads, installs, copies, or executes fixture contents; the engine resolver
stages them for the sandbox.
"""

from __future__ import annotations

import argparse
import asyncio
import subprocess
import sys
import time
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from kit_spine import make_notifier
from kit_spine.db import make_engine, make_session_factory
from kit_stream import StreamService

from ..config import REPO_ROOT, get_settings
from .corpus import Corpus, Entry, find_corpus
from .projector import HARNESS_TIMEOUT_CODE
from .store import Attempt, BenchRunStore, RunDescriptor

FIXTURES_DIR = REPO_ROOT / "sandbox" / "test-fixtures"

# Covers the measured scale-1 phase envelope. Large-package corpora must raise it
# explicitly rather than recording a slow successful audit as a timeout.
DEFAULT_TIMEOUT_MS = 5_400_000
DEFAULT_POLL_MS = 5_000

# Back-pressure policy for a full wait queue. Waiting is always the right answer:
# the queue drains as paid work finishes, and recording a VOID instead would let
# the harness's own impatience shrink the denominator.
_QUEUE_FULL_BACKOFF_SECONDS = 15.0
_QUEUE_FULL_MAX_WAIT_SECONDS = 1_800.0


class BenchRunnerError(RuntimeError):
    pass


def engine_sha(*, allow_dirty: bool) -> str:
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    dirty = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if dirty and not allow_dirty:
        raise BenchRunnerError(
            "refusing to run: the working tree is dirty, so `engineSha` would not "
            "describe the engine that produced the observations. Commit first, or "
            "pass --allow-dirty and treat the run as unpublishable."
        )
    return head


def sandbox_image_digest(image: str) -> str:
    """The concrete image id, resolved at run start.

    The configured image is a mutable local tag, not a reproducibility identifier.
    The local image id identifies the bytes the run actually used.
    """
    result = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", image],
        capture_output=True,
        text=True,
    )
    digest = result.stdout.strip()
    if result.returncode != 0 or not digest:
        raise BenchRunnerError(
            f"cannot resolve a digest for sandbox image {image!r}: "
            f"{result.stderr.strip() or 'docker image inspect failed'}. "
            "sandboxImageDigest is a mandatory run identifier."
        )
    return digest


@dataclass
class BenchApi:
    """Audit client with no cached-report short circuit."""

    base_url: str
    key: str
    timeout_ms: int
    poll_ms: int

    def __post_init__(self) -> None:
        self.client = httpx.AsyncClient(base_url=self.base_url.rstrip("/"), timeout=60)

    async def close(self) -> None:
        await self.client.aclose()

    async def health(self) -> None:
        response = await self.client.get("/health")
        if response.is_error:
            raise BenchRunnerError(f"engine /health returned {response.status_code}")

    async def admit(self, package_name: str, local_path: str) -> str:
        """Enqueue ONE fresh audit of a STAGED package. Blocks on back-pressure,
        never on a cache.

        The path is declared, not implied by the name: the engine attaches no
        meaning to a package name, so a corpus entry says where its bytes are.
        """
        deadline = time.monotonic() + _QUEUE_FULL_MAX_WAIT_SECONDS
        while True:
            response = await self.client.post(
                "/audit",
                headers={"x-api-key": self.key},
                json={"packageName": package_name, "localPath": local_path},
            )
            payload = response.json() if response.content else {}
            if response.status_code == 202 and isinstance(payload.get("auditId"), str):
                return payload["auditId"]
            code = payload.get("code")
            if code == "NPMGUARD-0040" and time.monotonic() < deadline:
                # The queue is full of REAL work. Wait for it, do not displace it.
                await asyncio.sleep(_QUEUE_FULL_BACKOFF_SECONDS)
                continue
            raise BenchRunnerError(
                f"admission refused ({response.status_code}"
                f"{'/' + code if code else ''}): "
                f"{payload.get('message') or payload.get('error') or response.text[:200]}"
            )

    async def wait(self, audit_id: str) -> bool:
        """Poll until the audit is terminal. ``False`` on a client-side timeout."""
        deadline = time.monotonic() + self.timeout_ms / 1_000
        path = f"/audit/{quote(audit_id, safe='')}/report"
        while time.monotonic() < deadline:
            response = await self.client.get(path)
            if response.status_code == 202:
                await asyncio.sleep(self.poll_ms / 1_000)
                continue
            return True
        return False


def _missing_fixtures(corpus: Corpus) -> list[Entry]:
    """Entries whose fixture directory is absent. Existence only — never a read."""
    return [entry for entry in corpus.entries if not (FIXTURES_DIR / entry.fixture_name).is_dir()]


async def _one(
    api: BenchApi,
    store: BenchRunStore,
    run_id: int,
    entry: Entry,
    run_index: int,
    gate: asyncio.Semaphore,
) -> None:
    async with gate:
        label = f"{entry.fixture_name}#{run_index}"
        try:
            audit_id = await api.admit(entry.fixture_name, str(FIXTURES_DIR / entry.fixture_name))
        except BenchRunnerError as exc:
            print(f"[bench:run] not admitted {label}: {exc}", file=sys.stderr)
            await store.record(run_id, Attempt(entry.fixture_name, run_index, None, str(exc), None))
            return
        settled = await api.wait(audit_id)
        # A client-side timeout is the harness measuring its own patience, so it is
        # recorded with a HARNESS code that the projector buckets VOID — never
        # ABSTAINED, which would blame the tool for the runner giving up.
        await store.record(
            run_id,
            Attempt(
                fixture_name=entry.fixture_name,
                run_index=run_index,
                audit_id=audit_id,
                error=None if settled else f"runner gave up after {api.timeout_ms}ms",
                code=None if settled else HARNESS_TIMEOUT_CODE,
            ),
        )
        print(f"[bench:run] recorded {label} -> {audit_id}")


async def bench_run(args: argparse.Namespace) -> int:
    settings = get_settings()
    if settings.mock_llm and not args.allow_mock_llm:
        raise BenchRunnerError(
            "refusing to run: NPMGUARD_MOCK_LLM is on, so the run would have no "
            "observed model, no tokens and no cost. Pass --allow-mock-llm only to "
            "exercise the harness."
        )
    key = settings.cre_api_key
    if not key:
        raise BenchRunnerError("NPMGUARD_CRE_API_KEY is required for the unbilled lane")

    corpus = find_corpus(args.corpus)
    missing = _missing_fixtures(corpus)
    if missing and not args.allow_missing_fixtures:
        raise BenchRunnerError(
            f"{len(missing)} of {len(corpus.entries)} fixtures are not on disk "
            f"(first: {missing[0].fixture_name}). A missing fixture is a corpus bug "
            "that voids its observations; materialise them or pass "
            "--allow-missing-fixtures to record the voids."
        )
    descriptor = RunDescriptor(
        dataset_version=corpus.dataset_version,
        manifest_sha=corpus.manifest_sha,
        engine_sha=engine_sha(allow_dirty=args.allow_dirty),
        sandbox_image_digest=sandbox_image_digest(settings.sandbox_image),
        runs_per_entry=args.runs,
    )

    db = make_engine(settings.database_url)
    sessions = make_session_factory(db)
    store = BenchRunStore(
        sessions=sessions,
        stream=StreamService(sessions, make_notifier(settings.database_url)),
    )
    api = BenchApi(base_url=args.api, key=key, timeout_ms=args.timeout_ms, poll_ms=args.poll_ms)
    try:
        await api.health()
        run_id = await store.create(descriptor, corpus.id)
        print(
            f"[bench:run] run {run_id} — {corpus.dataset_version} "
            f"({len(corpus.entries)} entries x {args.runs}) at {descriptor.engine_sha[:12]}"
        )
        gate = asyncio.Semaphore(args.concurrency)
        absent = {entry.fixture_name for entry in missing}
        runnable = [e for e in corpus.entries if e.fixture_name not in absent]
        for entry in missing:
            for index in range(args.runs):
                await store.record(
                    run_id,
                    Attempt(
                        entry.fixture_name,
                        index,
                        None,
                        f"fixture {entry.fixture_name} is not on disk",
                        "NPMGUARD-0001",
                    ),
                )
        await asyncio.gather(
            *(
                _one(api, store, run_id, entry, index, gate)
                for entry in runnable
                for index in range(args.runs)
            )
        )
        await store.finish(run_id)
        print(f"[bench:run] run {run_id} finished — GET /bench/runs/{run_id}/metrics")
    finally:
        await api.close()
        await db.dispose()
    return 0


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Add benchmark-runner flags to an argparse command."""
    parser.add_argument("--corpus", required=True, help="datasetVersion or name-version")
    parser.add_argument("--runs", type=int, default=2, help="observations per entry")
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--poll-ms", type=int, default=DEFAULT_POLL_MS)
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--allow-mock-llm", action="store_true")
    parser.add_argument("--allow-missing-fixtures", action="store_true")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m npmguard.bench.runner")
    add_arguments(parser)
    try:
        code = asyncio.run(bench_run(parser.parse_args()))
    except BenchRunnerError as exc:
        print(f"[bench:run] {exc}", file=sys.stderr)
        code = 1
    raise SystemExit(code)


if __name__ == "__main__":
    main()


__all__ = [
    "DEFAULT_TIMEOUT_MS",
    "FIXTURES_DIR",
    "BenchApi",
    "BenchRunnerError",
    "add_arguments",
    "bench_run",
    "engine_sha",
    "main",
    "sandbox_image_digest",
]
