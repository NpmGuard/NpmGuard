# CLASS MAP — panel.billing.BillingStore + payments subscription webhook fan-out
# (seam: real DB per test — throwaway sqlite over kit metadata.create_all; the
#  Stripe SDK is NEVER touched — the tested paths are pure DB state + offline
#  event dispatch. Settings built with explicit fields so nothing is read from a
#  live .env.)
#
# checkout_enabled gating (bool(stripe_secret_key AND stripe_pro_price_id)):
#   C1 both set                 -> True
#   C2 price id missing         -> False
#   C3 secret key missing       -> False
#   C4 neither set              -> False
#
# BillingStore.upsert_subscription:
#   C5 first upsert INSERTs the row (customer + subscription + status)
#   C6 second upsert UPDATEs subscription_id + status in place (one row)
#   C7 customer_id is COALESCE'd: an update with customer_id=None KEEPS the stored
#      customer; a non-None customer_id overwrites it
#
# BillingStore.find_installation_for_subscription:
#   C8  known subscription id      -> its installation id
#   C9  unknown subscription id    -> None
#   C10 None / empty id            -> None (no query)
#
# BillingStore.update_subscription_status:
#   C11 matching subscription id   -> status set, returns True
#   C12 non-matching id            -> returns False (no row mutated)
#
# BillingStore.installation_exists / get_billing_account:
#   C13 existing installation      -> True ; missing -> False
#   C14 get_billing_account: linked -> dict ; never-linked -> None
#
# Entitlements plan resolution (caps reads billing_accounts.subscription_status):
#   C15 status active/trialing (written via BillingStore) -> plan 'pro'
#   C16 status inactive/past_due/canceled                 -> plan 'free'
#   C17 UsageBucket remaining is None for a 0 (UNLIMITED) limit; a positive limit
#       reports max(0, limit-used)
#
# handle_subscription_event (OFFLINE — no Stripe retrieve on these branches):
#   C18 customer.subscription.updated w/ metadata.installationId -> upsert status
#   C19 customer.subscription.deleted linked by stored subscription id -> canceled
#   C20 customer.subscription.updated for an UNKNOWN installation -> None, no write
#   C21 checkout.session.completed WITHOUT kind=repo_pro_subscription -> None
#       (so the one-off audit branch runs) and no billing row is touched
#   C22 customer.subscription.deleted, no metadata + no stored row -> None
#
# Adversarial pass: 2026-07-24 — which dimension is missing? The COALESCE customer
#   retention (C7) is the load-bearing subtlety a naive upsert would drop (it
#   breaks the billing portal, which needs the customer id). Exercised directly
#   with an update carrying customer_id=None after a prior customer was stored.
import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from npmguard.config import Settings
from npmguard.panel import tables
from npmguard.panel.billing import BillingStore, checkout_enabled
from npmguard.panel.caps import CapsStore
from npmguard.payments import handle_subscription_event

# Import so metadata.create_all sees the panel tables.
_ = tables


def _settings(**overrides) -> Settings:
    base = dict(
        stripe_secret_key="sk_test_x",
        stripe_pro_price_id="price_pro",
        free_max_protected_repos=3,
        free_max_public_repo_audits=2,
        free_max_audits_month=250,
        pro_max_protected_repos=25,
        pro_max_public_repo_audits=0,  # unlimited
        pro_max_audits_month=5000,
    )
    base.update(overrides)
    return Settings(**base)


async def _fresh(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'billing.sqlite3'}")
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)
    sessions = make_session_factory(engine)
    return sessions, engine


async def _add_installation(sessions, installation_id: int, login: str = "acme") -> None:
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


@pytest.fixture
async def db(tmp_path):
    sessions, engine = await _fresh(tmp_path)
    yield sessions
    await engine.dispose()


# --- checkout_enabled gating ------------------------------------------------


@pytest.mark.parametrize(
    "overrides, expected",
    [
        ({}, True),  # C1
        ({"stripe_pro_price_id": None}, False),  # C2
        ({"stripe_secret_key": None}, False),  # C3
        ({"stripe_secret_key": None, "stripe_pro_price_id": None}, False),  # C4
    ],
)
def test_checkout_enabled_gating(overrides, expected):
    assert checkout_enabled(_settings(**overrides)) is expected


# --- BillingStore.upsert_subscription ---------------------------------------


async def test_upsert_inserts_then_updates_in_place(db):
    # C5 + C6
    await _add_installation(db, 10)
    store = BillingStore(db)
    await store.upsert_subscription(
        installation_id=10, customer_id="cus_1", subscription_id="sub_1", status="trialing"
    )
    first = await store.get_billing_account(10)
    assert first["stripe_customer_id"] == "cus_1"
    assert first["stripe_subscription_id"] == "sub_1"
    assert first["subscription_status"] == "trialing"

    await store.upsert_subscription(
        installation_id=10, customer_id="cus_1", subscription_id="sub_2", status="active"
    )
    async with db() as s:
        count = (
            await s.execute(
                sa.select(sa.func.count()).select_from(tables.billing_accounts)
            )
        ).scalar_one()
    assert count == 1  # updated in place, not a second row
    second = await store.get_billing_account(10)
    assert second["stripe_subscription_id"] == "sub_2"
    assert second["subscription_status"] == "active"


async def test_upsert_coalesces_customer_id(db):
    # C7 — a None customer on update must not wipe the stored customer.
    await _add_installation(db, 11)
    store = BillingStore(db)
    await store.upsert_subscription(
        installation_id=11, customer_id="cus_keep", subscription_id="sub_a", status="active"
    )
    # Update carrying no customer (e.g. a bare subscription.updated payload).
    await store.upsert_subscription(
        installation_id=11, customer_id=None, subscription_id="sub_a", status="past_due"
    )
    row = await store.get_billing_account(11)
    assert row["stripe_customer_id"] == "cus_keep"  # retained
    assert row["subscription_status"] == "past_due"
    # A non-None customer overwrites.
    await store.upsert_subscription(
        installation_id=11, customer_id="cus_new", subscription_id="sub_a", status="active"
    )
    assert (await store.get_billing_account(11))["stripe_customer_id"] == "cus_new"


# --- find / update / exists -------------------------------------------------


async def test_find_installation_for_subscription(db):
    # C8 / C9 / C10
    await _add_installation(db, 12)
    store = BillingStore(db)
    await store.upsert_subscription(
        installation_id=12, customer_id="cus_x", subscription_id="sub_find", status="active"
    )
    assert await store.find_installation_for_subscription("sub_find") == 12
    assert await store.find_installation_for_subscription("sub_missing") is None
    assert await store.find_installation_for_subscription(None) is None


async def test_update_subscription_status_returns_match(db):
    # C11 / C12
    await _add_installation(db, 13)
    store = BillingStore(db)
    await store.upsert_subscription(
        installation_id=13, customer_id=None, subscription_id="sub_u", status="active"
    )
    assert await store.update_subscription_status("sub_u", "canceled") is True
    assert (await store.get_billing_account(13))["subscription_status"] == "canceled"
    assert await store.update_subscription_status("sub_nope", "canceled") is False


async def test_installation_exists_and_get_account(db):
    # C13 / C14
    await _add_installation(db, 14)
    store = BillingStore(db)
    assert await store.installation_exists(14) is True
    assert await store.installation_exists(999) is False
    assert await store.get_billing_account(14) is None  # never linked
    await store.upsert_subscription(
        installation_id=14, customer_id="cus_g", subscription_id="sub_g", status="active"
    )
    assert (await store.get_billing_account(14))["stripe_customer_id"] == "cus_g"


# --- entitlements plan resolution over billing rows -------------------------


@pytest.mark.parametrize(
    "status, expected_plan",
    [
        ("active", "pro"),  # C15
        ("trialing", "pro"),  # C15
        ("inactive", "free"),  # C16
        ("past_due", "free"),  # C16
        ("canceled", "free"),  # C16
    ],
)
async def test_entitlements_plan_from_subscription_status(db, status, expected_plan):
    await _add_installation(db, 20)
    store = BillingStore(db)
    await store.upsert_subscription(
        installation_id=20, customer_id=None, subscription_id="sub_p", status=status
    )
    caps = CapsStore(db, _settings())
    entitlements = await caps.entitlements(20)
    assert entitlements["plan"] == expected_plan
    assert entitlements["subscriptionStatus"] == status


async def test_unlimited_bucket_remaining_is_none(db):
    # C17 — pro plan's public_repo_audits limit is 0 (UNLIMITED) -> remaining None;
    # a positive limit reports max(0, limit-used).
    await _add_installation(db, 21)
    store = BillingStore(db)
    await store.upsert_subscription(
        installation_id=21, customer_id=None, subscription_id="sub_un", status="active"
    )
    caps = CapsStore(db, _settings())
    entitlements = await caps.entitlements(21)
    assert entitlements["plan"] == "pro"
    assert entitlements["publicRepoAudits"]["limit"] == 0
    assert entitlements["publicRepoAudits"]["remaining"] is None
    # protected_repos has a positive pro limit (25), nothing used yet.
    assert entitlements["protectedRepos"]["remaining"] == 25


# --- handle_subscription_event (offline dispatch) ---------------------------


def _sub_event(event_type: str, obj: dict) -> dict:
    return {"type": event_type, "data": {"object": obj}}


async def test_subscription_updated_upserts_status(db):
    # C18 — metadata.installationId links the event; status is written.
    await _add_installation(db, 30)
    store = BillingStore(db)
    event = _sub_event(
        "customer.subscription.updated",
        {
            "id": "sub_30",
            "customer": "cus_30",
            "status": "active",
            "metadata": {"installationId": "30"},
        },
    )
    changed = await handle_subscription_event(_settings(), event, store)
    assert changed == {
        "kind": "subscription_synced",
        "subscriptionId": "sub_30",
        "status": "active",
    }
    row = await store.get_billing_account(30)
    assert row["subscription_status"] == "active"
    assert row["stripe_customer_id"] == "cus_30"


async def test_subscription_deleted_by_stored_id(db):
    # C19 — no metadata; linkage is the stored stripe_subscription_id.
    await _add_installation(db, 31)
    store = BillingStore(db)
    await store.upsert_subscription(
        installation_id=31, customer_id="cus_31", subscription_id="sub_31", status="active"
    )
    event = _sub_event(
        "customer.subscription.deleted",
        {"id": "sub_31", "customer": "cus_31", "status": "canceled", "metadata": {}},
    )
    changed = await handle_subscription_event(_settings(), event, store)
    assert changed["kind"] == "subscription_deleted"
    assert (await store.get_billing_account(31))["subscription_status"] == "canceled"


async def test_subscription_event_unknown_installation_ignored(db):
    # C20 — metadata points at an installation the App does not have -> no write.
    store = BillingStore(db)
    event = _sub_event(
        "customer.subscription.updated",
        {
            "id": "sub_ghost",
            "customer": "cus_ghost",
            "status": "active",
            "metadata": {"installationId": "404"},
        },
    )
    assert await handle_subscription_event(_settings(), event, store) is None
    async with db() as s:
        count = (
            await s.execute(
                sa.select(sa.func.count()).select_from(tables.billing_accounts)
            )
        ).scalar_one()
    assert count == 0


async def test_oneoff_checkout_completed_is_not_handled(db):
    # C21 — a one-off audit checkout (no subscription kind) returns None so the
    # caller falls through to the audit branch; billing state is untouched.
    store = BillingStore(db)
    event = _sub_event(
        "checkout.session.completed",
        {
            "id": "cs_oneoff",
            "metadata": {"packageName": "left-pad", "version": "1.0.0"},
        },
    )
    assert await handle_subscription_event(_settings(), event, store) is None


async def test_subscription_deleted_unlinked_is_noop(db):
    # C22 — deleted event with no metadata and no stored row -> None.
    store = BillingStore(db)
    event = _sub_event(
        "customer.subscription.deleted",
        {"id": "sub_orphan", "customer": None, "status": "canceled", "metadata": {}},
    )
    assert await handle_subscription_event(_settings(), event, store) is None
