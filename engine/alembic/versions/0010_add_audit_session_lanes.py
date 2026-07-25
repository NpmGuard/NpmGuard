"""give audit_sessions the panel queue's primitives: lane, org, origin, attempts, dedupe

R-2 / D-2. There were two queues solving one problem and the core had the weaker
one. `panel_jobs` was DB-backed with a durable state machine, a partial-unique
dedupe index and orphan recovery; `AuditService` was an in-process asyncio.Queue.
The durable claim landed first. This migration gives the core the four things
`panel_jobs` still had that the core did not, so that ONE queue can serve every
kind of work and the panel's second hop can be deleted.

  lane        which class of work this row is, and therefore its claim order, its
              admission bound and its retry budget (npmguard/lanes.py). NOT NULL
              with a server_default of 'paid', which is the honest reading of
              every row that predates lanes: it came in through /audit or
              /audit/stream, ahead of everything, refused rather than queued past
              the bound, never silently re-run.
  org         the FAIRNESS key for claim_next — one big install cannot starve the
              others. Explicitly NOT a billing field; money is metered in
              account_usage. NULL means the work belongs to no org, which is what
              a registry-watch audit and every paid one-off are.
  origin      the AuditSetOrigin this work came from, carried so an alert raised
              on the verdict knows where it came from. Lifted verbatim from
              panel_jobs, including the reason it exists there: the column it
              replaced was a scan_id FK whose only reader derived
              `"watch" if scan_id is None`, and so filed every public-repo scan's
              finding as a registry-watch alert.
  attempts    how many times execution has been tried. The retry budget is the
              lane's; the count is the row's.
  dedupe_key  "<name>@<version>" for work that is SHARED, NULL for work that is
              not. See below — this column is the whole reason the fold does not
              break paid audits.

THE DEDUPE INDEX, AND WHY IT IS OPT-IN
--------------------------------------
`ix_audit_sessions_active_dedupe` is PARTIAL UNIQUE over `dedupe_key` where the
row is active (`queued`/`running`) and the key is not NULL. It is the durable
backstop for the cross-process race the panel's pre-check SELECT cannot close,
and it is the same shape as `ix_panel_jobs_active_pkg`, which it replaces.

The key is NULLABLE and set only by the lanes that want sharing, and that is a
requirement rather than a convenience. Two audit sets needing the same
(package, version) genuinely SHOULD share one audit — that is what makes a scan
of 300 deps cheap, and set progress is computed from
`audit_set_items ⋈ package_verdicts` rather than from job ownership, so a shared
audit belonging to no single set is already the model. Two CUSTOMERS paying for
the same (package, version) must NOT share one: each proof bought an audit, each
caller is waiting on its own audit_id, and collapsing them would hand one
verdict to two payments and leave the second caller's row unreachable. So paid
rows carry no key and never dedupe.

Both `sqlite_where` and `postgresql_where` are supplied (N-11). A partial index
declared with only one of them silently becomes a FULL unique index on the other
engine, which here would mean "at most one audit per package ever" — the kind of
portability defect that passes every sqlite test and takes production down.

DATA
----
Purely additive; no row is rewritten. Existing rows read as lane='paid',
org/origin/dedupe_key NULL, attempts=0. `panel_jobs` is NOT touched here: D-2's
migration direction is lift the primitives up, move the callers over, THEN
delete, so that at no point does a proven path run on unproven code.
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_audit_lanes_0010"
down_revision = "npmguard_audit_claims_0009"
branch_labels = None
depends_on = None

_TABLE = "audit_sessions"
_LANE_INDEX = "ix_audit_sessions_lane_claim"
_DEDUPE_INDEX = "ix_audit_sessions_active_dedupe"
# The claim scan's own filter, as SQL text, for the partial indexes below.
_ACTIVE = "status IN ('queued', 'running')"
_DEDUPE_WHERE = f"dedupe_key IS NOT NULL AND {_ACTIVE}"


def upgrade() -> None:
    op.add_column(
        _TABLE,
        sa.Column("lane", sa.String(16), nullable=False, server_default="paid"),
    )
    op.add_column(_TABLE, sa.Column("org", sa.String(255), nullable=True))
    op.add_column(_TABLE, sa.Column("origin", sa.String(24), nullable=True))
    op.add_column(
        _TABLE,
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column(_TABLE, sa.Column("dedupe_key", sa.String(400), nullable=True))
    # Covers claim_next's candidate scan, which orders by lane before anything
    # else. The lease index stays: it serves the orphan sweep, whose
    # selectivity is the lease and not the lane.
    op.create_index(_LANE_INDEX, _TABLE, ["lane", "status", "created_at"])
    op.create_index(
        _DEDUPE_INDEX,
        _TABLE,
        ["dedupe_key"],
        unique=True,
        sqlite_where=sa.text(_DEDUPE_WHERE),
        postgresql_where=sa.text(_DEDUPE_WHERE),
    )


def downgrade() -> None:
    # REVERSIBLE and loses no audit data: every column here is dispatch metadata,
    # and the lane-unaware code reads none of it. A row mid-flight on a panel lane
    # lands as an ordinary audit — which is precisely what it was before the fold.
    op.drop_index(_DEDUPE_INDEX, table_name=_TABLE)
    op.drop_index(_LANE_INDEX, table_name=_TABLE)
    with op.batch_alter_table(_TABLE) as batch:
        batch.drop_column("dedupe_key")
        batch.drop_column("attempts")
        batch.drop_column("origin")
        batch.drop_column("org")
        batch.drop_column("lane")
