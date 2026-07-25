"""scope a public repo scan by its REQUESTER, not by a payer (D-1 / F-F5)

A public repo scan now requires a GitHub sign-in and nothing more: no App
installation, no repo ownership, nothing charged. That removes the only identity
the origin had — `billed_to` — from every public set, and `billed_to` was
load-bearing in three places, not one:

  1. `ix_audit_sets_active_public`, partial-unique on `(origin_ref, billed_to)`,
     which is what stops two concurrent live audits of one repo.
  2. Read authorization for a public set (`billed_to` -> `user_installations`).
  3. The public-audit allowance, counted per installation.

Leaving it NULL would have made (1) guarantee nothing — postgres treats distinct
NULLs as distinct, so the partial-unique index over a column that is NULL for
every row it covers admits unlimited duplicates — while still *looking* enforced.

So the requester moves up from the subject table onto the set, and the index
moves with it:

  public_repo_scans.requested_by  -> audit_sets.requested_by   (moved, not copied)
  ix_audit_sets_active_public     -> UNIQUE (origin_ref, requested_by)
                                     WHERE finished_at IS NULL
                                       AND origin = 'public_repo_scan'
  audit_sets.billed_to            -> NULLed for public sets. Not cosmetic: the
                                     column CASCADEs from `installations`, so
                                     leaving the old values in place would keep
                                     an uninstall deleting public scans that
                                     after D-1 belong to the user, not to any
                                     installation.

`audit_sets.requested_by` is nullable because most sets have no requester at all
(push, reconcile, registry watch, bench). The invariant that matters —
`origin = 'public_repo_scan'` implies `requested_by IS NOT NULL` and
`billed_to IS NULL` — is enforced in `AuditSetStore.create`, deliberately not as
a CHECK: this table carries no enum CHECKs so that adding an origin costs one
item-discovery function and no schema change (see 0007's docstring).

The backfill is TOTAL — `public_repo_scans.requested_by` was NOT NULL and 1:1
with its set — so no public set is left without an owner and the old
authorization path can be deleted outright rather than kept as a fallback.
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_public_requester_0008"
down_revision = "npmguard_verdict_domain_0007"
branch_labels = None
depends_on = None

_PARTIAL_WHERE = "finished_at IS NULL AND origin = 'public_repo_scan'"


def upgrade() -> None:
    with op.batch_alter_table("audit_sets") as batch:
        batch.add_column(
            sa.Column(
                "requested_by",
                sa.BigInteger,
                sa.ForeignKey("gh_users.id", ondelete="CASCADE"),
                nullable=True,
            )
        )

    # Move the requester up. Every public set has exactly one snapshot row and
    # that row's `requested_by` is NOT NULL, so this reaches all of them.
    op.execute(
        sa.text(
            """
            UPDATE audit_sets SET requested_by = (
                SELECT p.requested_by FROM public_repo_scans AS p
                WHERE p.set_id = audit_sets.id
            )
            WHERE origin = 'public_repo_scan'
            """
        )
    )
    # A public scan has no payer any more, and the CASCADE this drops is the
    # point: these sets outlive any installation.
    op.execute(
        sa.text("UPDATE audit_sets SET billed_to = NULL WHERE origin = 'public_repo_scan'")
    )

    op.drop_index("ix_audit_sets_active_public", table_name="audit_sets")
    op.create_index(
        "ix_audit_sets_active_public",
        "audit_sets",
        ["origin_ref", "requested_by"],
        unique=True,
        postgresql_where=sa.text(_PARTIAL_WHERE),
        sqlite_where=sa.text(_PARTIAL_WHERE),
    )

    # One fact, one column. Dropped only AFTER the backfill above has read it.
    #
    # `dep_count` arrives in the same batch: the snapshot now records how many
    # pairs the lockfile held, because a cost ceiling can make the set cover less
    # than that and the set knows only its own coverage. Existing rows predate any
    # ceiling and were covered in full, so their item count IS their dep count —
    # a true value, not a placeholder.
    with op.batch_alter_table("public_repo_scans") as batch:
        batch.drop_column("requested_by")
        batch.add_column(
            sa.Column("dep_count", sa.Integer, nullable=False, server_default="0")
        )
    op.execute(
        sa.text(
            """
            UPDATE public_repo_scans SET dep_count = (
                SELECT COUNT(*) FROM audit_set_items AS i
                WHERE i.set_id = public_repo_scans.set_id
            )
            """
        )
    )


def downgrade() -> None:
    # Reversible, unlike 0006: every value this migration moves still exists
    # somewhere afterwards. `billed_to` is the exception and is NOT restored —
    # which installation once paid for a public scan is genuinely gone, and
    # inventing one (say, any installation the requester can access) would be a
    # fabricated billing record. A downgraded database therefore has public sets
    # with a NULL `billed_to`, which the index over that column does not
    # constrain. Named here rather than discovered later.
    with op.batch_alter_table("public_repo_scans") as batch:
        batch.add_column(
            sa.Column(
                "requested_by",
                sa.BigInteger,
                sa.ForeignKey("gh_users.id", ondelete="CASCADE"),
                nullable=True,
            )
        )
        batch.drop_column("dep_count")
    op.execute(
        sa.text(
            """
            UPDATE public_repo_scans SET requested_by = (
                SELECT a.requested_by FROM audit_sets AS a
                WHERE a.id = public_repo_scans.set_id
            )
            """
        )
    )
    # Back to its original NOT NULL: the backfill is total, because a public set
    # cannot exist without a requester.
    with op.batch_alter_table("public_repo_scans") as batch:
        batch.alter_column("requested_by", existing_type=sa.BigInteger(), nullable=False)

    op.drop_index("ix_audit_sets_active_public", table_name="audit_sets")
    op.create_index(
        "ix_audit_sets_active_public",
        "audit_sets",
        ["origin_ref", "billed_to"],
        unique=True,
        postgresql_where=sa.text(_PARTIAL_WHERE),
        sqlite_where=sa.text(_PARTIAL_WHERE),
    )
    with op.batch_alter_table("audit_sets") as batch:
        batch.drop_column("requested_by")
