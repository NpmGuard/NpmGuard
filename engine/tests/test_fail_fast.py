# CLASS MAP — flag fan-out failure semantics (public run_flag over a real package
# + provider injected through build_npmguard_llm — no private phase imports)
# Axes: which sibling fails, what the surviving in-flight sibling observes
#   C1 one file's model chain fails      — run_flag raises AuditIncompleteError naming that file
#   C2 sibling in-flight call cancelled  — the concurrent sibling's provider call is cancelled
#                                          promptly instead of running (and billing) to completion
# Adversarial pass: 2026-07-23/W6 — the old test proved private _gather_fail_fast
# in isolation; this proves the same guarantee holds through the public phase
# entrypoint with the real semaphore fan-out in between.
import asyncio
import json

import pytest

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.errors import AuditIncompleteError
from npmguard.inventory import analyze_inventory
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.phases import PackageIntent, run_flag

# Generous outer bound: a regression that stops cancelling siblings would
# otherwise hang this test forever on the never-resolving provider call.
FAN_OUT_DEADLINE_SECONDS = 30


class _FanOutProvider:
    """hang.js's call blocks until cancelled; poison.js waits until the sibling
    is provably in flight, then fails every model in the chain."""

    def __init__(self) -> None:
        self.sibling_in_flight = asyncio.Event()
        self.sibling_cancelled = asyncio.Event()

    async def complete(self, request):
        content = request.messages[-1]["content"]
        if "hang.js" in content:
            self.sibling_in_flight.set()
            try:
                await asyncio.Event().wait()  # resolves only via cancellation
            except asyncio.CancelledError:
                self.sibling_cancelled.set()
                raise
        await self.sibling_in_flight.wait()
        raise RuntimeError("poisoned model transport")

    async def stream(self, request, on_token):
        return await self.complete(request)

    async def lookup_cost(self, provider_call_id):
        return 0.0

    async def aclose(self) -> None:
        return None


async def test_failed_file_cancels_sibling_flag_work(tmp_path, monkeypatch) -> None:
    """C1+C2: poison.js exhausts its chain -> AuditIncompleteError names it, and
    hang.js's still-running model call is cancelled instead of left running."""
    monkeypatch.setenv("NPMGUARD_TRIAGE_CONCURRENCY", "8")  # both files truly concurrent
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'fanout.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    provider = _FanOutProvider()
    llm = build_npmguard_llm(make_session_factory(engine), Settings(_env_file=None), provider=provider)
    package = tmp_path / "package"
    package.mkdir()
    (package / "package.json").write_text(
        json.dumps({"name": "fixture", "main": "hang.js"}), encoding="utf-8"
    )
    (package / "hang.js").write_text("module.exports = 1;\n", encoding="utf-8")
    (package / "poison.js").write_text("module.exports = 2;\n", encoding="utf-8")
    inventory = await analyze_inventory(package)
    intent = PackageIntent(statedPurpose="fixture", expectedCapabilities=[], rationale="manifest")

    async with asyncio.timeout(FAN_OUT_DEADLINE_SECONDS):
        with pytest.raises(AuditIncompleteError, match="poison.js"):
            await run_flag(package, inventory, intent, llm, "audit-1")

    assert provider.sibling_cancelled.is_set()
    await llm.aclose()
    await engine.dispose()
