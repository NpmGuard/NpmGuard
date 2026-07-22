import asyncio

import pytest

from npmguard.phases import _gather_fail_fast


async def test_gather_fail_fast_cancels_sibling_work() -> None:
    sibling_cancelled = asyncio.Event()

    async def fail() -> None:
        await asyncio.sleep(0)
        raise RuntimeError("invalid model output")

    async def expensive_sibling() -> None:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            sibling_cancelled.set()
            raise

    with pytest.raises(RuntimeError, match="invalid model output"):
        await _gather_fail_fast([expensive_sibling(), fail()])

    assert sibling_cancelled.is_set()
