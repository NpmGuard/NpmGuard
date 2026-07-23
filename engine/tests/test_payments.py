# CLASS MAP — payments.verify_audit_payment + exact-once claim flow + Stripe surface
# (seams: FakeChainRpc/StripeStub behind REAL HTTP sockets; throwaway sqlite DB;
#  postgres claim variants gated on NPMGUARD_TEST_PG_DSN with a loud skip)
# Chain config: C1 chain unconfigured → ChainVerificationError (route maps to 501, S6)
#               C2 other chain ("base") unconfigured → same refusal
# Receipt:      C3 valid receipt, status=1, log at contract, topic+(pkg,ver) match → VerifiedPayment
#               C4 receipt arrives DELAYED (<30s) → verified via wait_for polling
#                  (C17: stub delay, never a wall-clock 30s; poll count observed at the stub)
#               C5 receipt fetch fails (dead RPC) → ChainVerificationError, not a crash
#                  (the 30s TimeExhausted path exits through this same except-branch —
#                   never wall-clocked in tests)
#               C6 reverted tx (status=0) → error
#               C7 no log at the configured contract address → error
#               C8 event topic mismatch → error
#               C9 decoded packageName mismatch → error (C11 claim)
#               C10 decoded version mismatch → error (C11 claim)
#               C11 multiple logs, one matching → accepted
#               C12 malformed log data (abi decode raises) → clean error, not a crash
#               C12b right topic0 but <2 topics (no requester) → skipped → clean error
# Fee read:     C24 read_audit_fee configured + stub fee → the wei value
#               C25 unconfigured chain → None (no RPC call at all)
#               C26 eth_call failure → raises (the /config/public caller maps any
#                   raise to crypto:null — pinned at the seam, not swallowed here)
# Claim:        C13 new (provider,key) → created=True, session AND claim row both exist
#               C14 duplicate sequential → created=False, same auditId
#               C15 duplicate CONCURRENT → exactly one created
#                   [sqlite serializes writers — the honest variant is postgres-marked]
#               C16 claim durable across engine restart (same DB file, fresh engine)
#               C17 atomicity: 12-way claim race leaves exactly ONE session row (no orphans)
# Stripe:       C18 unpaid session → paid:False + package metadata echoed (route: 402)
#               C19 paid session → paid:True + packageName/version/email echoed
#               C23 session without package metadata → typed RuntimeError (route: 402),
#                   never an AttributeError (stripe 15.x StripeObject is not a dict)
#               C20 stripe API exception (unknown session) → typed stripe error propagates
#                   (route maps to 402), never swallowed into a fake success
#               C21 webhook construct: valid HMAC accepted / bad signature rejected (offline)
#               C22 GLOBAL stripe.api_key/api_base mutation across two Settings — PINNED,
#                   UNENFORCED (module-global config is process-wide, last writer wins)
# Adversarial pass: W5 2026-07-23 — "does any error path fall through to an implicit
#   success?" → every refusal class asserts ChainVerificationError/typed stripe error;
#   C17 pairs the negative (no dup claims) with a positive probe (exactly one live session).
import asyncio
import os

import pytest
import stripe
from web3 import Web3

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.payments import (
    ChainVerificationError,
    chain_contract,
    construct_webhook_event,
    create_checkout_session,
    is_chain_configured,
    read_audit_fee,
    verify_audit_payment,
    verify_checkout_session,
)
from npmguard.persistence import AuditSessionStore
from tests.support.stubs import FakeChainRpc, StripeStub

CONTRACT = Web3.to_checksum_address("0x" + "12" * 20)
DEAD_RPC = "http://127.0.0.1:1"  # nothing listens: instant connection refusal
RECEIPT_DELAY_SECONDS = 1.0  # < web3 poll latency (2s); keeps C4 to one extra poll
GATHER_TIMEOUT_SECONDS = 30

pg_gate = pytest.mark.skipif(
    not os.environ.get("NPMGUARD_TEST_PG_DSN"),
    reason=(
        "postgres claim class needs NPMGUARD_TEST_PG_DSN — sqlite serializes writers, "
        "so the CONCURRENT exactly-once clause is only falsifiable under Postgres MVCC"
    ),
)


@pytest.fixture(scope="module")
def chain():
    with FakeChainRpc() as rpc:
        yield rpc


@pytest.fixture(autouse=True)
def _fresh_stub_state(chain):
    chain.clear()
    # payments._stripe mutates process-global stripe config (pinned by C22);
    # restore it so this file never leaks configuration into other test files.
    key, base = stripe.api_key, stripe.api_base
    yield
    stripe.api_key, stripe.api_base = key, base


@pytest.fixture(scope="module")
def stripe_stub():
    with StripeStub() as stub:
        yield stub


@pytest.fixture
def stripe_settings(stripe_stub):
    stripe_stub.clear()
    return Settings(
        _env_file=None,
        stripe_secret_key="sk_test_x",
        stripe_webhook_secret="whsec_test",
        stripe_api_base=stripe_stub.base_url,
    )


def _chain_settings(chain) -> Settings:
    return Settings(
        _env_file=None,
        base_sepolia_rpc_url=chain.base_url,
        base_sepolia_contract=CONTRACT,
    )


async def _sqlite_store(path) -> tuple[AuditSessionStore, object]:
    engine = make_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    return AuditSessionStore(make_session_factory(engine)), engine


# ── Chain config ──────────────────────────────────────────────────────────────


async def test_unconfigured_chain_refuses_verification() -> None:
    """C1: no contract address configured → not is_chain_configured, and
    verify_audit_payment refuses with ChainVerificationError (API layer: 501)."""
    settings = Settings(_env_file=None)
    assert not is_chain_configured(settings, "base-sepolia")
    assert chain_contract(settings, "base-sepolia") is None
    with pytest.raises(ChainVerificationError, match="not configured"):
        await verify_audit_payment(settings, "base-sepolia", "0x" + "11" * 32, "left-pad", "1.3.0")


async def test_other_chain_unconfigured_refuses_independently(chain) -> None:
    """C2: configuring base-sepolia does not configure base — each chain's
    contract gates its own verification."""
    settings = _chain_settings(chain)
    assert is_chain_configured(settings, "base-sepolia")
    assert not is_chain_configured(settings, "base")
    with pytest.raises(ChainVerificationError, match="not configured"):
        await verify_audit_payment(settings, "base", "0x" + "11" * 32, "left-pad", "1.3.0")


# ── Receipt verification ──────────────────────────────────────────────────────


async def test_valid_receipt_verifies_payment(chain) -> None:
    """C3: a status=1 receipt with a matching AuditRequested log at the configured
    contract yields VerifiedPayment carrying requester, fee, block, explorer URL."""
    tx = "0x" + "aa" * 32
    requester = "0x00000000000000000000000000000000000000A1"
    chain.add_receipt(
        tx, contract=CONTRACT, package_name="left-pad", version="1.3.0", fee_wei=5 * 10**14
    )
    verified = await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")
    assert verified.package_name == "left-pad"
    assert verified.version == "1.3.0"
    assert verified.requester == Web3.to_checksum_address(requester)
    assert verified.fee_paid == 5 * 10**14
    assert verified.block_number == 0x10
    assert verified.explorer_url == f"https://sepolia.basescan.org/tx/{tx}"


async def test_delayed_receipt_is_polled_for_not_fetched_once(chain) -> None:
    """C4 (claim C17): the receipt appears only after a stub-controlled delay; the
    engine verifies anyway because it WAITS (polls) instead of a single get. The
    stub's request log shows >1 receipt poll. No wall-clock 30s anywhere."""
    tx = "0x" + "bb" * 32
    chain.add_receipt(
        tx,
        contract=CONTRACT,
        package_name="left-pad",
        version="1.3.0",
        delay_seconds=RECEIPT_DELAY_SECONDS,
    )
    verified = await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")
    assert verified.package_name == "left-pad"
    polls = [req for req in chain.requests if req["method"] == "eth_getTransactionReceipt"]
    assert len(polls) >= 2, "delayed receipt must be polled, not fetched once"


async def test_unreachable_rpc_maps_to_verification_error() -> None:
    """C5: receipt fetch failure (connection refused) surfaces as a clean
    ChainVerificationError — the 30s TimeExhausted timeout exits through this
    same except-branch and is deliberately never wall-clocked in tests."""
    settings = Settings(
        _env_file=None, base_sepolia_rpc_url=DEAD_RPC, base_sepolia_contract=CONTRACT
    )
    with pytest.raises(ChainVerificationError, match="Could not fetch receipt"):
        await verify_audit_payment(settings, "base-sepolia", "0x" + "cc" * 32, "left-pad", "1.3.0")


async def test_reverted_tx_rejected(chain) -> None:
    """C6: a status=0 receipt is a reverted payment → error, never verified."""
    tx = "0x" + "dd" * 32
    chain.add_receipt(tx, contract=CONTRACT, package_name="left-pad", version="1.3.0", status=0)
    with pytest.raises(ChainVerificationError, match="reverted"):
        await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")


async def test_log_at_wrong_contract_rejected(chain) -> None:
    """C7: a perfect AuditRequested log emitted by a DIFFERENT contract address
    does not count as interacting with the audit contract."""
    tx = "0x" + "ee" * 32
    other = Web3.to_checksum_address("0x" + "34" * 20)
    chain.add_receipt(
        tx, contract=CONTRACT, package_name="left-pad", version="1.3.0", log_address=other
    )
    with pytest.raises(ChainVerificationError, match="did not interact"):
        await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")


async def test_wrong_event_topic_rejected(chain) -> None:
    """C8: a log at the right contract under a different event signature is
    skipped → no matching AuditRequested event."""
    tx = "0x" + "0f" * 32
    chain.add_receipt(
        tx, contract=CONTRACT, package_name="left-pad", version="1.3.0", wrong_event=True
    )
    with pytest.raises(ChainVerificationError, match="No matching AuditRequested"):
        await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")


async def test_package_name_mismatch_rejected(chain) -> None:
    """C9 (claim C11): the decoded event must name the EXACT package being audited."""
    tx = "0x" + "1a" * 32
    chain.add_receipt(tx, contract=CONTRACT, package_name="other-pkg", version="1.3.0")
    with pytest.raises(ChainVerificationError, match="No matching AuditRequested"):
        await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")


async def test_version_mismatch_rejected(chain) -> None:
    """C10 (claim C11): paying for one version does not verify another."""
    tx = "0x" + "1b" * 32
    chain.add_receipt(tx, contract=CONTRACT, package_name="left-pad", version="9.9.9")
    with pytest.raises(ChainVerificationError, match="No matching AuditRequested"):
        await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")


async def test_multiple_logs_one_matching_accepted(chain) -> None:
    """C11: extra unrelated logs in the receipt (wrong topic) do not mask the one
    valid AuditRequested event."""
    tx = "0x" + "1c" * 32
    noise = FakeChainRpc.audit_requested_log(
        contract=CONTRACT,
        package_name="left-pad",
        version="1.3.0",
        requester="0x00000000000000000000000000000000000000A1",
        fee_wei=1,
        wrong_event=True,
    )
    chain.add_receipt(
        tx, contract=CONTRACT, package_name="left-pad", version="1.3.0", extra_logs=[noise]
    )
    verified = await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")
    assert verified.package_name == "left-pad"


async def test_malformed_log_data_is_clean_error_not_crash(chain) -> None:
    """C12: a log with the right topic but undecodable ABI data is skipped;
    the result is the normal no-matching-event error, never a decode traceback."""
    tx = "0x" + "1d" * 32
    log = FakeChainRpc.audit_requested_log(
        contract=CONTRACT,
        package_name="left-pad",
        version="1.3.0",
        requester="0x00000000000000000000000000000000000000A1",
        fee_wei=1,
    )
    log["data"] = "0xdeadbeef"  # decode(["string","string","uint256"]) raises
    receipt = {
        "transactionHash": tx,
        "transactionIndex": "0x0",
        "blockHash": "0x" + "00" * 32,
        "blockNumber": "0x10",
        "from": "0x" + "00" * 20,
        "to": CONTRACT,
        "cumulativeGasUsed": "0x5208",
        "gasUsed": "0x5208",
        "contractAddress": None,
        "logs": [log],
        "logsBloom": "0x" + "00" * 256,
        "status": "0x1",
        "effectiveGasPrice": "0x1",
        "type": "0x2",
    }
    chain.add_raw_receipt(tx, receipt)
    with pytest.raises(ChainVerificationError, match="No matching AuditRequested"):
        await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")


async def test_log_with_topic_but_no_requester_is_skipped(chain) -> None:
    """C12b: a log carrying the right topic0 but fewer than 2 topics (no indexed
    requester) is skipped, ending in the normal no-matching-event error."""
    tx = "0x" + "1e" * 32
    log = FakeChainRpc.audit_requested_log(
        contract=CONTRACT,
        package_name="left-pad",
        version="1.3.0",
        requester="0x00000000000000000000000000000000000000A1",
        fee_wei=1,
    )
    log["topics"] = log["topics"][:1]  # topic0 only — requester topic missing
    receipt = {
        "transactionHash": tx,
        "transactionIndex": "0x0",
        "blockHash": "0x" + "00" * 32,
        "blockNumber": "0x10",
        "from": "0x" + "00" * 20,
        "to": CONTRACT,
        "cumulativeGasUsed": "0x5208",
        "gasUsed": "0x5208",
        "contractAddress": None,
        "logs": [log],
        "logsBloom": "0x" + "00" * 256,
        "status": "0x1",
        "effectiveGasPrice": "0x1",
        "type": "0x2",
    }
    chain.add_raw_receipt(tx, receipt)
    with pytest.raises(ChainVerificationError, match="No matching AuditRequested"):
        await verify_audit_payment(_chain_settings(chain), "base-sepolia", tx, "left-pad", "1.3.0")


# ── Fee read (/config/public's chain surface) ─────────────────────────────────


async def test_read_audit_fee_configured_returns_wei(chain) -> None:
    """C24: a configured chain with a stub-scripted auditFee returns the wei value."""
    chain.set_audit_fee(5 * 10**14)
    assert await read_audit_fee(_chain_settings(chain), "base-sepolia") == 5 * 10**14


async def test_read_audit_fee_unconfigured_is_none(chain) -> None:
    """C25: an unconfigured chain reads as None without any RPC traffic."""
    settings = Settings(_env_file=None)
    assert await read_audit_fee(settings, "base-sepolia") is None
    assert chain.requests == []  # no eth_call was ever attempted


async def test_read_audit_fee_call_failure_raises(chain) -> None:
    """C26: an eth_call failure (no fee scripted → RPC error) RAISES out of
    read_audit_fee — the /config/public caller catches any raise and serves
    crypto:null; nothing here may silently fake a fee."""
    with pytest.raises(Exception, match="unscripted eth_call"):
        await read_audit_fee(_chain_settings(chain), "base-sepolia")


# ── Exact-once claims ─────────────────────────────────────────────────────────


async def test_new_claim_creates_session_and_claim_row(tmp_path) -> None:
    """C13: a fresh (provider,key) claim creates the session AND the claim row
    together — both observable immediately afterwards."""
    store, engine = await _sqlite_store(tmp_path / "claims.sqlite3")
    try:
        session, created = await store.claim_payment(
            "chain:base-sepolia", "0xabc", "left-pad", "1.3.0", requester="0xA1"
        )
        assert created is True
        assert (await store.get(session.audit_id)) is not None
        claim = await store.payment("chain:base-sepolia", "0xabc")
        assert claim is not None
        assert claim["audit_id"] == session.audit_id
        assert (claim["package_name"], claim["version"]) == ("left-pad", "1.3.0")
    finally:
        await engine.dispose()


async def test_duplicate_sequential_claim_returns_original(tmp_path) -> None:
    """C14: re-presenting the same payment proof yields created=False and the
    ORIGINAL audit session — a proof buys exactly one audit."""
    store, engine = await _sqlite_store(tmp_path / "claims.sqlite3")
    try:
        first, created_first = await store.claim_payment("stripe", "cs_1", "left-pad", "1.3.0")
        second, created_second = await store.claim_payment("stripe", "cs_1", "left-pad", "1.3.0")
        assert created_first is True
        assert created_second is False
        assert second.audit_id == first.audit_id
    finally:
        await engine.dispose()


async def test_concurrent_claims_exactly_once_and_no_orphan_sessions(tmp_path) -> None:
    """C15+C17 (sqlite): 12 concurrent claims of one key → one created=True, one
    audit id — and the positive probe: exactly ONE live session row exists (a
    losing claim must not leave an orphaned session)."""
    store, engine = await _sqlite_store(tmp_path / "claims.sqlite3")
    try:
        async with asyncio.timeout(GATHER_TIMEOUT_SECONDS):
            claims = await asyncio.gather(
                *(store.claim_payment("stripe", "cs_race", "left-pad", "1.3.0") for _ in range(12))
            )
        assert len({session.audit_id for session, _ in claims}) == 1
        assert sum(created for _, created in claims) == 1
        assert len(await store.running()) == 1  # no orphan sessions from losers
    finally:
        await engine.dispose()


@pytest.mark.postgres
@pg_gate
async def test_concurrent_claims_exactly_once_postgres() -> None:
    """C15 (postgres): the honest concurrent proof — under MVCC, 12 simultaneous
    claims still bind the key to exactly one session with no orphans."""
    from tests.support.harness import PostgresProvisioner

    provisioner = PostgresProvisioner.start()
    engine = make_engine(provisioner.fresh_database())
    try:
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        store = AuditSessionStore(make_session_factory(engine))
        async with asyncio.timeout(GATHER_TIMEOUT_SECONDS):
            claims = await asyncio.gather(
                *(store.claim_payment("stripe", "cs_race", "left-pad", "1.3.0") for _ in range(12))
            )
        assert len({session.audit_id for session, _ in claims}) == 1
        assert sum(created for _, created in claims) == 1
        assert len(await store.running()) == 1
    finally:
        await engine.dispose()
        provisioner.stop()


async def test_claim_durable_across_engine_restart(tmp_path) -> None:
    """C16 (claim C10): a claim written before a restart still binds the key
    after a fresh engine opens the same database."""
    path = tmp_path / "durable.sqlite3"
    store, engine = await _sqlite_store(path)
    original, _ = await store.claim_payment("chain:base-sepolia", "0xdur", "left-pad", "1.3.0")
    await engine.dispose()

    reopened = make_engine(f"sqlite+aiosqlite:///{path}")
    try:
        restored = AuditSessionStore(make_session_factory(reopened))
        claim = await restored.payment("chain:base-sepolia", "0xdur")
        assert claim is not None and claim["audit_id"] == original.audit_id
        session, created = await restored.claim_payment(
            "chain:base-sepolia", "0xdur", "left-pad", "1.3.0"
        )
        assert created is False
        assert session.audit_id == original.audit_id
    finally:
        await reopened.dispose()


# ── Stripe ────────────────────────────────────────────────────────────────────


async def test_verify_unpaid_session_reports_unpaid(stripe_stub, stripe_settings) -> None:
    """C18: an unpaid session verifies cleanly to paid=False with its package
    metadata echoed — the route layer refuses paid=False with 402; verification
    itself never crashes on a metadata-bearing StripeObject (stripe 15.x)."""
    stripe_stub.add_session("cs_unpaid", package_name="left-pad", version="1.3.0", payment_status="unpaid")
    result = await verify_checkout_session(stripe_settings, "cs_unpaid")
    assert result == {"paid": False, "packageName": "left-pad", "version": "1.3.0", "email": None}


async def test_verify_paid_session_returns_paid_metadata(stripe_stub, stripe_settings) -> None:
    """C19: a fully paid session verifies — paid=True with packageName, version,
    and customer email echoed for the claim path."""
    stripe_stub.add_session(
        "cs_paid", package_name="left-pad", version="1.3.0", payment_status="paid", email="a@b.c"
    )
    result = await verify_checkout_session(stripe_settings, "cs_paid")
    assert result == {"paid": True, "packageName": "left-pad", "version": "1.3.0", "email": "a@b.c"}


async def test_verify_session_without_metadata_is_typed_error(stripe_stub, stripe_settings) -> None:
    """C23: a paid session missing packageName/version metadata is refused with the
    typed RuntimeError (route: 402) — never an AttributeError crash."""
    stripe_stub.sessions["cs_nometa"] = {
        "id": "cs_nometa",
        "object": "checkout.session",
        "payment_status": "paid",
        "status": "complete",
        "metadata": {},
        "customer_email": None,
    }
    with pytest.raises(RuntimeError, match="missing package metadata"):
        await verify_checkout_session(stripe_settings, "cs_nometa")


async def test_unknown_session_raises_typed_stripe_error(stripe_settings) -> None:
    """C20: an unknown session id surfaces stripe's own InvalidRequestError
    (mapped to 402 by the route) — never swallowed into a fake verification."""
    with pytest.raises(stripe.InvalidRequestError, match="No such checkout.session"):
        await verify_checkout_session(stripe_settings, "cs_missing")


async def test_create_checkout_session_returns_url_and_id(stripe_stub, stripe_settings) -> None:
    """C20-adjacent smoke: session creation posts metadata AND the configured
    charge amount (audit_price_cents → line_items unit_amount — the revenue
    field), returning (url, id) — proves the K4 api_base seam carries the full
    create path."""
    url, session_id = await create_checkout_session(
        stripe_settings, package_name="left-pad", version="1.3.0", email="a@b.c", origin="http://o"
    )
    assert url.startswith("https://checkout.stripe.example/pay/")
    stored = stripe_stub.sessions[session_id]
    assert stored["metadata"] == {"packageName": "left-pad", "version": "1.3.0"}
    assert stored["customer_email"] == "a@b.c"
    form = stripe_stub.create_forms[-1]
    assert form["line_items[0][price_data][unit_amount]"] == str(
        stripe_settings.audit_price_cents
    )
    assert form["line_items[0][price_data][currency]"] == "usd"
    assert form["line_items[0][quantity]"] == "1"


def test_webhook_hmac_valid_and_invalid(stripe_settings) -> None:
    """C21: webhook construction is offline HMAC — a correctly signed payload
    yields the event, a wrong v1 signature raises SignatureVerificationError."""
    import hashlib
    import hmac
    import json
    import time

    payload = json.dumps(
        {
            "id": "evt_1",
            "object": "event",
            "type": "checkout.session.completed",
            "data": {"object": {"id": "cs_paid"}},
            "api_version": stripe.api_version,
            "created": 1,
            "livemode": False,
            "pending_webhooks": 0,
            "request": None,
        }
    ).encode()
    timestamp = int(time.time())
    signature = hmac.new(
        b"whsec_test", f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    event = construct_webhook_event(stripe_settings, payload, f"t={timestamp},v1={signature}")
    assert event.type == "checkout.session.completed"
    with pytest.raises(stripe.SignatureVerificationError):
        construct_webhook_event(stripe_settings, payload, f"t={timestamp},v1={'0' * 64}")


async def test_global_stripe_config_mutation_pinned(stripe_stub) -> None:
    """C22 — PINNED, UNENFORCED: _stripe() mutates process-global stripe.api_key /
    stripe.api_base, so the LAST Settings wins for every in-flight caller. Two
    engines with different Stripe accounts in one process would interleave."""
    first = Settings(_env_file=None, stripe_secret_key="sk_first", stripe_api_base=stripe_stub.base_url)
    second = Settings(_env_file=None, stripe_secret_key="sk_second", stripe_api_base=DEAD_RPC)
    with pytest.raises(stripe.InvalidRequestError):
        await verify_checkout_session(first, "cs_none")  # configures globals to `first`
    assert stripe.api_key == "sk_first"
    with pytest.raises(Exception):  # noqa: B017 - dead endpoint; the probe is the globals below
        await verify_checkout_session(second, "cs_none")
    assert stripe.api_key == "sk_second"  # `first` verification would now use second's key
    assert stripe.api_base == DEAD_RPC
