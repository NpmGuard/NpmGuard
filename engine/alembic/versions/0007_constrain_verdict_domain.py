"""constrain package_verdicts.verdict to the audit-core domain (SAFE|DANGEROUS)

Adds ``CHECK (verdict IN ('SAFE', 'DANGEROUS'))`` and deletes the rows that violate
it.

WHY A CONSTRAINT AND NOT AN ASSERT
----------------------------------
The verdict collapse (``d1c4cd7``) licensed every one of its deletions under N-4
rule 3 ("delete-iff-asserted") on the strength of bare ``assert`` statements. Under
``python -O`` those vanish: ``item_outcome('UNKNOWN', pending=False)`` then returns
``'UNKNOWN'``, the wider domain flows again, and the deleted branches are gone — the
enforcement was CONDITIONALLY COMPILED, in exactly the configuration a production
deploy may use. A DB ``CHECK`` cannot be compiled away.

THE OTHER ENUM COLUMNS DELIBERATELY GET NO CONSTRAINT
-----------------------------------------------------
`audit_sets.origin` / `trigger_kind`, `alerts.outcome` / `origin`,
`panel_jobs.state` / `origin` all hold domain enums and are all left unconstrained,
because their domains are OPEN by design, and a CHECK on an open domain is a
liability. `audit_set.py` lists `dep_tree` and `bench_run` as "designed-for, not
built … so adding either costs an item-discovery function and NO schema or wire
change" — a CHECK converts that into "a function AND a migration".
`alerts.outcome` is `Literal['DANGEROUS']` today and §4.4 argues at length that
ERROR is "a fact worth showing", so an ERROR alert is a plausible next value; and
`alerts` is notification HISTORY, not a derived index, so a constraint violation
there would not be recoverable by a rebuild.

Those columns are guarded instead by boundary checks written as `raise
AssertionError` rather than `assert`, so `-O` cannot remove them either
(`audit_set.AuditSetStore.create`, `alerts.notify.handle_dangerous_verdict`).

DATA
----
`package_verdicts` is a DERIVED, rebuildable index of `data/reports/`
(`verdict_index.rebuild` at boot), which is what makes a hard constraint cheap
rather than risky. Rows outside the domain are deleted here, LOUDLY (the count is
logged, and this docstring is the record):

  - such a row is corruption relative to the domain either way: `item_outcome`
    raises on it, which is a 500 on a user's dashboard on every read, forever;
  - `verdict_index.rebuild` only `continue`s past an unreadable report and never
    DELETEs, so the row is neither removed nor overwritten by any boot — this
    migration is the only thing that removes it, and the CHECK is what stops it
    coming back;
  - the authoritative copy is the report file, so the boot rebuild restores every
    row that still has one.
"""

import logging

import sqlalchemy as sa

from alembic import op

revision = "npmguard_verdict_domain_0007"
down_revision = "npmguard_audit_sets_0006"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# The literal DDL text, NOT interpolated from verdict_index.LANDABLE_VERDICTS. A
# migration is a frozen historical statement: a constraint whose text moved when a
# Python constant was edited would silently diverge from what every
# already-migrated database actually holds.
_DOMAIN_SQL = "verdict IN ('SAFE', 'DANGEROUS')"
# Matches kit_spine.db.metadata's `ck` naming convention
# (`ck_%(table_name)s_%(constraint_name)s`) applied to name="verdict_domain" in
# panel/tables.py, so the migrated schema and `metadata.create_all` agree — which
# tests/test_panel_migration.py C11 asserts with alembic's compare_metadata.
_CONSTRAINT = "ck_package_verdicts_verdict_domain"


def upgrade() -> None:
    # Deleted BEFORE the constraint is added, because on sqlite `batch_alter_table`
    # adds a CHECK by recreating the table and copying every row THROUGH it — a
    # surviving out-of-domain row would abort the migration rather than be caught.
    removed = (
        op.get_bind()
        .execute(sa.text(f"DELETE FROM package_verdicts WHERE NOT ({_DOMAIN_SQL})"))
        .rowcount
    )
    if removed:
        log.warning(
            "0007 removed %d package_verdicts row(s) outside the SAFE|DANGEROUS "
            "domain; they are re-derived from data/reports/ by the boot rebuild",
            removed,
        )

    # batch mode is required on sqlite (no ALTER TABLE ADD CONSTRAINT); on postgres
    # it degrades to a plain ALTER TABLE ADD CONSTRAINT.
    with op.batch_alter_table("package_verdicts") as batch:
        batch.create_check_constraint(_CONSTRAINT, _DOMAIN_SQL)


def downgrade() -> None:
    # Reversible, unlike 0006: dropping a CHECK restores the previous SCHEMA
    # exactly and loses no column. The rows `upgrade` deleted are not restored and
    # do not need to be — `package_verdicts` is a derived index whose authoritative
    # copy is `data/reports/`, and `verdict_index.rebuild` repopulates it at every
    # boot.
    with op.batch_alter_table("package_verdicts") as batch:
        batch.drop_constraint(_CONSTRAINT, type_="check")
