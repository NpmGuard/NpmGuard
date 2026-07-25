"""drop panel_jobs — the second queue has no callers left

The last step of the fold (D-2). `audit_sessions` now carries the lane, the org
fairness key, the origin, the attempt count and the active-dedupe index that made
`panel_jobs` worth having, and every producer and consumer has moved onto it: scan
and watch enqueue into the one queue, set progress reads item state from
`audit_sessions`, and the settle hook does what the panel's worker pool did after
awaiting an admit future. A job row written now would be read by nothing.

WHAT HAPPENS TO WORK IN FLIGHT ACROSS THIS MIGRATION
----------------------------------------------------
Rows in `queued`/`running` here are audits that were never re-enqueued onto the new
queue, and dropping the table forgets them. That is deliberate and it is not a
dropped paid audit: `panel_jobs` only ever held cache-filling scan and watch work,
whose set progress is computed from `audit_set_items ⋈ package_verdicts`. An item
whose job is forgotten reads as ERROR — a visible coverage gap — and the next scan
of that repo re-enqueues the pair, because a pair with no verdict is a cache miss.
`refresh_live` at boot finalizes any set left waiting so no check run spins forever.

The alternative — copying live job rows into `audit_sessions` — was rejected: it
would mean minting audit rows from a table whose `attempts` and retry history do
not map onto a lane's budget, to save re-auditing a handful of dependencies that
the next scan asks for anyway.

DOWNGRADE recreates the table, empty, exactly as `panel/tables.py` declared it —
including the partial-unique active-pair index with both `sqlite_where` and
`postgresql_where` (N-11). Empty is the honest restoration: the pre-fold code reads
`panel_jobs` to decide what is in flight, and after the fold nothing is, so a
resurrected queue starts idle and the next scan fills it.
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_drop_panel_jobs_0011"
down_revision = "npmguard_audit_lanes_0010"
branch_labels = None
depends_on = None

_TABLE = "panel_jobs"
_ACTIVE_PAIR_WHERE = "state IN ('queued','running')"


def _surrogate_pk() -> sa.types.TypeEngine:
    """BIGSERIAL on postgres, INTEGER (rowid) on sqlite.

    A plain BigInteger autoincrement PK does not auto-generate on sqlite, which
    only aliases the rowid for a column typed exactly INTEGER — a BIGINT PRIMARY
    KEY inserts NULL and violates NOT NULL.
    """
    return sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.drop_index("ix_panel_jobs_active_pkg", table_name=_TABLE)
    op.drop_index("ix_panel_jobs_state", table_name=_TABLE)
    op.drop_table(_TABLE)


def downgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
        sa.Column("kind", sa.String(32), nullable=False, server_default="audit_package"),
        sa.Column("lane", sa.String(16), nullable=False, server_default="cheap"),
        sa.Column("org", sa.String(255), nullable=True),
        sa.Column("origin", sa.String(24), nullable=False, server_default="watchlist"),
        sa.Column("package_name", sa.String(214), nullable=False),
        sa.Column("version", sa.String(128), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.String(64), nullable=False),
        sa.Column("started_at", sa.String(64), nullable=True),
        sa.Column("finished_at", sa.String(64), nullable=True),
    )
    op.create_index("ix_panel_jobs_state", _TABLE, ["state", "lane", "created_at"])
    op.create_index(
        "ix_panel_jobs_active_pkg",
        _TABLE,
        ["package_name", "version"],
        unique=True,
        sqlite_where=sa.text(_ACTIVE_PAIR_WHERE),
        postgresql_where=sa.text(_ACTIVE_PAIR_WHERE),
    )
