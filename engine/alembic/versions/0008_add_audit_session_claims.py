"""give audit_sessions a durable work claim (claimed_by + lease_expires_at)

Work ownership was a process-local `dict[audit_id, asyncio.Future]` in
`AuditService`. That made the class docstring's guarantee — "status == running iff
an owned worker task will finalize the row" — true only *within one process*: the
row said an audit was live, but nothing durable said WHO was responsible for it,
so an orphaned `running` row could only ever be repaired by the same process's own
successor at its next boot. AUDIT_CORE_EXPLAINED §4.6 enumerates the consequences
under two processes, including a `_recover` that finalizes another live process's
rows and then makes its `finalize` assert.

These two columns move ownership into SQL:

  claimed_by        the opaque id of the service INCARNATION holding the row
                    (host:pid:random — the random part matters, see below)
  lease_expires_at  the instant that claim goes stale, ISO string, same
                    convention as every other timestamp in this schema

  status == 'running'    =>  someone claimed this row and owes a terminal state
  the claim has lapsed   =>  that someone is gone, and the row is recoverable
                             BY SOMEONE OTHER THAN IT

WHY NOT A NEW `status` VALUE
----------------------------
`status` is on the wire (the generated contract declares the domain), and a claim
is not a lifecycle stage a client has any business seeing. Keeping the claim
ORTHOGONAL to `status` also buys the state this design needs and a merged column
could not express: `status='queued' AND claimed_by IS NOT NULL` — claimed, but
never started. Shutdown must RELEASE that row's claim without terminalizing it,
because a never-started paid claim that a crash would have preserved must not be
dropped by a graceful stop. Collapsing claim+start into one `queued -> running`
transition looks simpler and silently converts that row into a terminal error.

WHY THE ID CARRIES A RANDOM SUFFIX
----------------------------------
Recovery rests on "a claim stamped by someone who is not me is one I may
reclaim". A restarted process that reused its PID on the same host would be
mistaken for its own predecessor and would decline to recover exactly the rows it
exists to recover. `host:pid` is not an incarnation; `host:pid:random` is.

THE INDEX
---------
`ix_audit_sessions_lease (status, lease_expires_at)` covers both claim scans: the
claimable candidate (`status='queued'` + a dead claim) and the orphan sweep
(`status='running'` + a dead claim). The existing `ix_audit_sessions_status` stays
— it serves the plain status filters (`running()`, `queued()`, `queued_count()`),
whose selectivity does not depend on the claim.

DATA
----
Purely additive. Both columns are NULLABLE with no server default, so every
existing row reads as "unclaimed", which is exactly right: no row in a database
that predates this migration is claimed by anyone. `running` rows carried across
from before are recovered by startup recovery as they always were — it sweeps
every non-demo `running` row regardless of claim, precisely so a pre-migration
row (and a row whose claim has not yet lapsed) is not left looking live.
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_audit_claims_0008"
down_revision = "npmguard_verdict_domain_0007"
branch_labels = None
depends_on = None

_TABLE = "audit_sessions"
_INDEX = "ix_audit_sessions_lease"


def upgrade() -> None:
    # Plain add_column: adding a NULLABLE column with no default is one of the
    # few ALTER TABLE forms sqlite supports natively, so batch mode (which would
    # rebuild and copy the whole table) is not needed here.
    op.add_column(_TABLE, sa.Column("claimed_by", sa.String(64), nullable=True))
    op.add_column(_TABLE, sa.Column("lease_expires_at", sa.String(64), nullable=True))
    op.create_index(_INDEX, _TABLE, ["status", "lease_expires_at"])


def downgrade() -> None:
    # REVERSIBLE, and it loses no audit data. The only thing these columns hold is
    # live claim state, which is meaningful only to a running process: every row's
    # audit_id, status, report, error and event history is untouched. A `running`
    # row that loses its claim on the way down lands in precisely the state the
    # pre-0008 code expects, because that code recovers EVERY non-demo `running`
    # row at startup and never consulted a claim in the first place.
    #
    # batch mode IS required here — sqlite has no ALTER TABLE DROP COLUMN before
    # 3.35 and alembic's batch path rebuilds the table; on postgres it degrades to
    # two plain ALTER TABLEs.
    op.drop_index(_INDEX, table_name=_TABLE)
    with op.batch_alter_table(_TABLE) as batch:
        batch.drop_column("lease_expires_at")
        batch.drop_column("claimed_by")
