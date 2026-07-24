# CLASS MAP — panel.caps.CapsStore entitlements + quota enforcement
# (seam: real DB per test — throwaway sqlite over kit metadata.create_all;
#  Settings built with explicit free_/pro_ limits so quotas are injected, not
#  read from a live .env)
# Plan resolution (subscription_status axis):
#   C1 status 'active'   -> plan 'pro'
#   C2 status 'trialing' -> plan 'pro'
#   C3 status 'inactive' -> plan 'free'
#   C4 status 'past_due' / 'canceled' (any non-active) -> plan 'free'
#   C5 NO billing_accounts row at all -> subscriptionStatus 'inactive', plan 'free'
# Limit semantics (limit==0 = UNLIMITED):
#   C6 a 0-limit bucket reports remaining=None and never raises its cap
#   C7 a positive-limit bucket reports remaining = max(0, limit-used)
# Protect cap boundary (protected_repos):
#   C8  under limit -> passes
#   C9  exactly at limit (used==limit) -> raises CapExceededError(resource=protected_repos)
#   C10 unlimited (limit 0) at high usage -> passes
#   only protected_at IS NOT NULL repos count toward the cap
# Public-repo-audit cap boundary (public_repo_audits):
#   C11 under limit -> passes; count is DISTINCT github_repo_id
#   C12 at limit, NEW repo id -> raises (resource=public_repo_audits)
#   C13 at limit, but re-audit of an ALREADY-scanned repo id -> passes (free)
# Monthly audit budget (monthly_audits):
#   C14 used + count <= limit -> passes
#   C15 used + count > limit  -> raises (resource=monthly_audits)
#   C16 unlimited (limit 0) -> passes for any count
# consume_audit_budget accumulation:
#   C17 first consume in a month inserts the row; second ADDS within the month
#   C18 a different month is a SEPARATE row -> budget resets across months
#   C19 consume of count<=0 is a no-op (no row written)
# Error shape:
#   C20 CapExceededError carries .cap True, .resource, .installation_id, .entitlements
#   C21 unknown installation id -> LookupError (not a silent free plan)
# Adversarial pass: 2026-07-24 — which dimension is missing? The month-boundary
#   reset (C18) needs the account_usage.month key exercised directly rather than
#   via wall-clock; the test seeds two month rows and reads back through
#   entitlements pinned to the CURRENT month, plus a direct-row assertion for the
#   other month.
import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.panel import tables
from npmguard.panel.caps import CapExceededError, CapsStore

# Import so metadata.create_all sees the panel tables.
_ = tables


def _settings(**overrides) -> Settings:
    base = dict(
        free_max_protected_repos=3,
        free_max_public_repo_audits=2,
        free_max_audits_month=250,
        pro_max_protected_repos=25,
        pro_max_public_repo_audits=0,  # unlimited
        pro_max_audits_month=5000,
    )
    base.update(overrides)
    # env_prefix is NPMGUARD_; pass fields directly (pydantic-settings still reads
    # the process env for anything omitted, but these override it).
    return Settings(**base)


async def _fresh(tmp_path, **settings_overrides):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'caps.sqlite3'}")
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    store = CapsStore(sessions, _settings(**settings_overrides))
    return store, sessions, engine


async def _add_installation(
    sessions, installation_id: int, login: str = "acme", subscription_status: str | None = None
) -> None:
    now = now_iso()
    async with sessions() as s, s.begin():
        await s.execute(
            tables.installations.insert().values(
                id=installation_id,
                account_login=login,
                account_type="Organization",
                created_at=now,
                updated_at=now,
            )
        )
        if subscription_status is not None:
            await s.execute(
                tables.billing_accounts.insert().values(
                    installation_id=installation_id,
                    subscription_status=subscription_status,
                    created_at=now,
                    updated_at=now,
                )
            )


async def _add_repo(sessions, repo_id: int, installation_id: int, *, protected: bool) -> None:
    now = now_iso()
    async with sessions() as s, s.begin():
        await s.execute(
            tables.repos.insert().values(
                id=repo_id,
                installation_id=installation_id,
                owner="acme",
                name=f"r{repo_id}",
                full_name=f"acme/r{repo_id}",
                protected_at=now if protected else None,
                created_at=now,
                updated_at=now,
            )
        )


async def _add_user(sessions, user_id: int = 1) -> None:
    now = now_iso()
    async with sessions() as s, s.begin():
        await s.execute(
            tables.gh_users.insert().values(
                id=user_id, login=f"u{user_id}", created_at=now, updated_at=now
            )
        )


async def _add_public_scan(
    sessions, scan_id: int, installation_id: int, github_repo_id: int, requested_by: int = 1
) -> None:
    now = now_iso()
    async with sessions() as s, s.begin():
        await s.execute(
            tables.public_repo_scans.insert().values(
                id=scan_id,
                installation_id=installation_id,
                requested_by=requested_by,
                github_repo_id=github_repo_id,
                owner="acme",
                name=f"pub{github_repo_id}",
                full_name=f"acme/pub{github_repo_id}",
                full_name_lower=f"acme/pub{github_repo_id}",
                html_url="https://github.com/acme/pub",
                default_branch="main",
                lockfile_path="package-lock.json",
                lockfile_sha="deadbeef",
                status="done",
                started_at=now,
            )
        )


async def _set_usage(sessions, installation_id: int, month: str, audits: int) -> None:
    async with sessions() as s, s.begin():
        await s.execute(
            tables.account_usage.insert().values(
                installation_id=installation_id, month=month, audits=audits
            )
        )


@pytest.fixture
async def db(tmp_path):
    store, sessions, engine = await _fresh(tmp_path)
    yield store, sessions
    await engine.dispose()


# --- Plan resolution ------------------------------------------------------


@pytest.mark.parametrize(
    "status, expected_plan",
    [
        ("active", "pro"),  # C1
        ("trialing", "pro"),  # C2
        ("inactive", "free"),  # C3
        ("past_due", "free"),  # C4
        ("canceled", "free"),  # C4
    ],
)
async def test_plan_resolution_by_status(db, status, expected_plan) -> None:
    """C1-C4: subscription_status maps active|trialing->pro, everything else->free."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status=status)
    ent = await store.entitlements(1)
    assert ent["subscriptionStatus"] == status
    assert ent["plan"] == expected_plan


async def test_no_billing_row_is_free_inactive(db) -> None:
    """C5: an installation with no billing_accounts row is free / 'inactive'."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status=None)
    ent = await store.entitlements(1)
    assert ent["subscriptionStatus"] == "inactive"
    assert ent["plan"] == "free"


# --- Limit semantics ------------------------------------------------------


async def test_zero_limit_is_unlimited_remaining_none(db) -> None:
    """C6: a 0 limit (pro publicRepoAudits) reports remaining=None (unlimited)."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="active")  # pro
    ent = await store.entitlements(1)
    assert ent["publicRepoAudits"]["limit"] == 0
    assert ent["publicRepoAudits"]["remaining"] is None


async def test_positive_limit_remaining_is_limit_minus_used(db) -> None:
    """C7: a positive limit reports remaining = max(0, limit-used)."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")  # free
    await _add_repo(sessions, 10, 1, protected=True)  # one protected repo used
    ent = await store.entitlements(1)
    assert ent["protectedRepos"]["limit"] == 3
    assert ent["protectedRepos"]["used"] == 1
    assert ent["protectedRepos"]["remaining"] == 2


# --- Protect cap boundary -------------------------------------------------


async def test_protect_cap_under_limit_passes(db) -> None:
    """C8: below the protected-repo limit, assert_protect_cap passes."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")
    await _add_repo(sessions, 10, 1, protected=True)
    await _add_repo(sessions, 11, 1, protected=False)  # unprotected doesn't count
    await store.assert_protect_cap(1)  # 1 protected < 3


async def test_protect_cap_at_limit_raises(db) -> None:
    """C9: at the protected-repo limit, assert_protect_cap raises."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")
    for rid in (10, 11, 12):
        await _add_repo(sessions, rid, 1, protected=True)  # 3 == free limit
    with pytest.raises(CapExceededError) as exc:
        await store.assert_protect_cap(1)
    assert exc.value.resource == "protected_repos"


async def test_protect_cap_unlimited_passes_at_high_usage(tmp_path) -> None:
    """C10: with a 0 (unlimited) protected limit, no usage level raises."""
    store, sessions, engine = await _fresh(tmp_path, pro_max_protected_repos=0)
    try:
        await _add_installation(sessions, 1, subscription_status="active")  # pro
        for rid in range(100, 130):
            await _add_repo(sessions, rid, 1, protected=True)
        await store.assert_protect_cap(1)  # unlimited -> passes
    finally:
        await engine.dispose()


# --- Public-repo-audit cap boundary --------------------------------------


async def test_public_cap_under_limit_passes(db) -> None:
    """C11: below the public-audit limit (distinct repo ids), passes."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")  # free, limit 2
    await _add_user(sessions)
    await _add_public_scan(sessions, 100, 1, github_repo_id=555)
    await store.assert_public_repo_audit_cap(1, github_repo_id=999)  # 1 used < 2


async def test_public_cap_at_limit_new_repo_raises(db) -> None:
    """C12: at the public-audit limit, a NEW repo id raises."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")
    await _add_user(sessions)
    await _add_public_scan(sessions, 100, 1, github_repo_id=555)
    await _add_public_scan(sessions, 101, 1, github_repo_id=556)  # 2 distinct == limit
    with pytest.raises(CapExceededError) as exc:
        await store.assert_public_repo_audit_cap(1, github_repo_id=777)
    assert exc.value.resource == "public_repo_audits"


async def test_public_cap_reaudit_of_known_repo_is_free(db) -> None:
    """C13: at the limit, re-auditing an already-scanned repo id passes (free)."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")
    await _add_user(sessions)
    await _add_public_scan(sessions, 100, 1, github_repo_id=555)
    await _add_public_scan(sessions, 101, 1, github_repo_id=556)  # at limit
    # Re-audit of 555 (already counted) must not raise even though we're at cap.
    await store.assert_public_repo_audit_cap(1, github_repo_id=555)


# --- Monthly audit budget -------------------------------------------------


async def test_audit_budget_within_limit_passes(db) -> None:
    """C14: used + count <= limit passes."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")  # limit 250
    await _set_usage(sessions, 1, _now_month(), 200)
    await store.assert_audit_budget(1, 50)  # 200 + 50 == 250


async def test_audit_budget_over_limit_raises(db) -> None:
    """C15: used + count > limit raises (monthly_audits)."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")
    await _set_usage(sessions, 1, _now_month(), 200)
    with pytest.raises(CapExceededError) as exc:
        await store.assert_audit_budget(1, 51)  # 251 > 250
    assert exc.value.resource == "monthly_audits"


async def test_audit_budget_unlimited_passes(tmp_path) -> None:
    """C16: a 0 (unlimited) monthly limit passes for any count."""
    store, sessions, engine = await _fresh(tmp_path, free_max_audits_month=0)
    try:
        await _add_installation(sessions, 1, subscription_status="inactive")
        await _set_usage(sessions, 1, _now_month(), 10_000)
        await store.assert_audit_budget(1, 10_000)  # unlimited
    finally:
        await engine.dispose()


# --- consume_audit_budget accumulation -----------------------------------


async def test_consume_accumulates_within_month(db) -> None:
    """C17: two consumes in the same month add up (insert then increment)."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")
    await store.consume_audit_budget(1, 3)
    await store.consume_audit_budget(1, 4)
    ent = await store.entitlements(1)
    assert ent["monthlyAudits"]["used"] == 7
    assert ent["monthlyAudits"]["remaining"] == 250 - 7


async def test_consume_resets_across_months(db) -> None:
    """C18: a prior-month usage row does not count toward the current month."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")
    await _set_usage(sessions, 1, "2000-01", 999)  # ancient month
    await store.consume_audit_budget(1, 5)  # current month
    ent = await store.entitlements(1)
    assert ent["monthlyAudits"]["used"] == 5  # only current month counted
    # The old row is untouched.
    async with sessions() as s:
        old = (
            await s.execute(
                sa.select(tables.account_usage.c.audits).where(
                    tables.account_usage.c.installation_id == 1,
                    tables.account_usage.c.month == "2000-01",
                )
            )
        ).scalar_one()
    assert old == 999


async def test_consume_nonpositive_is_noop(db) -> None:
    """C19: consume of 0 (or negative) writes no row."""
    store, sessions = db
    await _add_installation(sessions, 1, subscription_status="inactive")
    await store.consume_audit_budget(1, 0)
    async with sessions() as s:
        rows = (
            await s.execute(
                sa.select(sa.func.count()).select_from(tables.account_usage)
            )
        ).scalar_one()
    assert rows == 0


# --- Error shape + unknown installation ----------------------------------


async def test_cap_error_carries_resource_and_entitlements(db) -> None:
    """C20: CapExceededError exposes .cap/.resource/.installation_id/.entitlements."""
    store, sessions = db
    await _add_installation(sessions, 7, subscription_status="inactive")
    for rid in (10, 11, 12):
        await _add_repo(sessions, rid, 7, protected=True)
    with pytest.raises(CapExceededError) as exc:
        await store.assert_protect_cap(7)
    err = exc.value
    assert err.cap is True
    assert err.resource == "protected_repos"
    assert err.installation_id == 7
    assert err.entitlements["installationId"] == 7
    assert err.entitlements["protectedRepos"]["used"] == 3


async def test_unknown_installation_raises_lookup(db) -> None:
    """C21: an unknown installation id raises LookupError, not a silent free plan."""
    store, _sessions = db
    with pytest.raises(LookupError):
        await store.entitlements(4242)


# --- helpers --------------------------------------------------------------


def _now_month() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).strftime("%Y-%m")
