"""collapse scans + public_repo_scans into audit_sets (R-1)

Three near-identical "set of packages to audit, plus a rollup" entities existed or
were planned. This migration turns the two that exist into one, and carries every
row across.

Mapping (old -> new), and the two columns with no home, named rather than dropped
silently:

  scans.id                 -> audit_sets.id                (unchanged; ids preserved)
  scans.repo_id            -> audit_sets.origin_ref        (origin='repo_scan')
  repos.installation_id    -> audit_sets.billed_to         (joined through repo_id)
  scans.trigger_kind       -> audit_sets.trigger_kind
  scans.commit_sha         -> audit_sets.commit_sha
  scans.check_run_id       -> audit_sets.check_run_id
  scans.started_at         -> audit_sets.started_at
  scans.status/finished_at -> audit_sets.finished_at        (ONE column: 'done' now
                              means finished_at IS NOT NULL, so a legacy done row
                              with a NULL finished_at is healed to started_at)
  scans.total/cached/audited/failed  -> DROPPED. Derived on read from
                              audit_set_items x package_verdicts; keeping them was
                              how a crashed worker could desynchronize a counter
                              from reality.
  scans.error              -> NO HOME. A TEXT column with zero writers repo-wide
                              (falsified by grep before removal), paired with a
                              status='failed' that also had none. Both are gone.

  scan_items.(scan_id,name,version,cached) -> audit_set_items.(set_id,name,version,cached)
  scan_items                               -> .direct / .range BACKFILLED from
                              repo_deps for the same repo where the pair still
                              exists there. scan_items never stored either, so any
                              pair no longer in the index lands direct=false,
                              range=NULL — the only genuinely lossy step here, and
                              it is lossy in the old schema, not in this one.

  public_repo_scans.id                -> audit_sets.id      (OFFSET past max(scans.id))
  public_repo_scans.github_repo_id    -> audit_sets.origin_ref (origin='public_repo_scan')
  public_repo_scans.installation_id   -> audit_sets.billed_to
  public_repo_scans.commit_sha        -> audit_sets.commit_sha
  public_repo_scans.started_at/status/finished_at -> as above
  public_repo_scans.{owner,name,full_name,html_url,default_branch,lockfile_path,
                     lockfile_sha,requested_by,github_repo_id}
                                      -> KEPT, on a rebuilt public_repo_scans whose
                                         PRIMARY KEY is now set_id (1:1 with the set,
                                         so `scan.id` and `set.id` are one column)
  public_repo_scans.full_name_lower   -> NO HOME. It existed only to make the
                                         active-scan uniqueness case-insensitively
                                         portable; the stable github_repo_id in
                                         origin_ref supersedes it, and does not
                                         break when a repo is renamed.
  public_repo_scans.total/cached/audited/failed/error -> DROPPED, as above.
  public_repo_scan_items.*            -> audit_set_items.*

  panel_jobs.scan_id       -> DROPPED, replaced by panel_jobs.origin. Its only
                              reader derived "watch if scan_id is None else scan",
                              which filed every public-repo audit's finding as a
                              registry-watch alert. Historical rows are backfilled
                              'repo_scan' when they carried a scan_id and
                              'watchlist' otherwise — the public-repo jobs among
                              the latter are indistinguishable in the old data,
                              which is the bug being fixed.
  alerts.verdict           -> alerts.outcome
  alerts.kind ('scan'|'watch') -> alerts.origin ('repo_scan'|'watchlist')
  alerts.message           -> NOT NULL (backfilled to ''). Its single writer always
                              composes one, and the wire declares it non-null, so
                              nullable here only bought every reader a coercion.

Public-audit snapshot URLs change, because a public scan's id is now its set id
(offset past the scans sequence). That is accepted: ids are not a published API and
one id per set is what makes `scanId` mean the same thing on every route.
"""

import sqlalchemy as sa

from alembic import op


def _surrogate_pk() -> sa.BigInteger:
    # BIGSERIAL on postgres, INTEGER (rowid autoincrement) on sqlite. Mirrors
    # npmguard/panel/tables._surrogate_pk so create_all and this migration match.
    return sa.BigInteger().with_variant(sa.Integer(), "sqlite")


revision = "npmguard_audit_sets_0006"
down_revision = "npmguard_panel_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    op.create_table(
        "audit_sets",
        sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
        sa.Column("origin", sa.String(24), nullable=False),
        sa.Column("origin_ref", sa.BigInteger, nullable=False),
        sa.Column(
            "billed_to",
            sa.BigInteger,
            sa.ForeignKey("installations.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("trigger_kind", sa.String(16), nullable=False),
        sa.Column("commit_sha", sa.String(64), nullable=True),
        sa.Column("check_run_id", sa.BigInteger, nullable=True),
        sa.Column("started_at", sa.String(64), nullable=False),
        sa.Column("finished_at", sa.String(64), nullable=True),
    )
    op.create_index(
        "ix_audit_sets_subject", "audit_sets", ["origin", "origin_ref", "started_at"]
    )
    op.create_index(
        "ix_audit_sets_active_public",
        "audit_sets",
        ["origin_ref", "billed_to"],
        unique=True,
        postgresql_where=sa.text("finished_at IS NULL AND origin = 'public_repo_scan'"),
        sqlite_where=sa.text("finished_at IS NULL AND origin = 'public_repo_scan'"),
    )

    op.create_table(
        "audit_set_items",
        sa.Column(
            "set_id",
            sa.BigInteger,
            sa.ForeignKey("audit_sets.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("name", sa.String(214), primary_key=True),
        sa.Column("version", sa.String(128), primary_key=True),
        sa.Column("direct", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("range", sa.String(255), nullable=True),
        sa.Column("cached", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_audit_set_items_pkg", "audit_set_items", ["name", "version"])

    # --- carry the repo scans across -------------------------------------------
    op.execute(
        sa.text(
            """
            INSERT INTO audit_sets (
                id, origin, origin_ref, billed_to, trigger_kind,
                commit_sha, check_run_id, started_at, finished_at
            )
            SELECT
                s.id, 'repo_scan', s.repo_id, r.installation_id, s.trigger_kind,
                s.commit_sha, s.check_run_id, s.started_at,
                CASE WHEN s.status = 'running' THEN NULL
                     ELSE COALESCE(s.finished_at, s.started_at) END
            FROM scans AS s
            JOIN repos AS r ON r.id = s.repo_id
            """
        )
    )
    # direct / range recovered from the repo's CURRENT dep index where the pair is
    # still there; scan_items never carried either.
    #
    # FALSE, not 0, for the missing-pair default (N-11). `direct` is sa.Boolean, and
    # postgres refuses `COALESCE(boolean, integer)` outright — "DatatypeMismatch:
    # COALESCE types boolean and integer cannot be matched" — which aborted this
    # migration and therefore the entire chain on postgres. sqlite's dynamic typing
    # accepted the 0 silently, so the defect was invisible on the tier that runs by
    # default.
    op.execute(
        sa.text(
            """
            INSERT INTO audit_set_items (set_id, name, version, direct, range, cached)
            SELECT
                si.scan_id, si.name, si.version,
                COALESCE(d.direct, FALSE), d.range, si.cached
            FROM scan_items AS si
            JOIN audit_sets AS a ON a.id = si.scan_id AND a.origin = 'repo_scan'
            LEFT JOIN repo_deps AS d
                   ON d.repo_id = a.origin_ref
                  AND d.name = si.name
                  AND d.version = si.version
            """
        )
    )

    # --- carry the public scans across, offset past the scans ids ---------------
    offset = bind.execute(sa.text("SELECT COALESCE(MAX(id), 0) FROM audit_sets")).scalar() or 0
    op.execute(
        sa.text(
            """
            INSERT INTO audit_sets (
                id, origin, origin_ref, billed_to, trigger_kind,
                commit_sha, check_run_id, started_at, finished_at
            )
            SELECT
                p.id + :offset, 'public_repo_scan', p.github_repo_id,
                p.installation_id, 'manual', p.commit_sha, NULL, p.started_at,
                CASE WHEN p.status = 'running' THEN NULL
                     ELSE COALESCE(p.finished_at, p.started_at) END
            FROM public_repo_scans AS p
            """
        ).bindparams(offset=offset)
    )
    op.execute(
        sa.text(
            """
            INSERT INTO audit_set_items (set_id, name, version, direct, range, cached)
            SELECT i.scan_id + :offset, i.name, i.version, i.direct, i.range, i.cached
            FROM public_repo_scan_items AS i
            """
        ).bindparams(offset=offset)
    )

    # Stash the subject columns so the old table can be dropped and the new one
    # created under its real name — created via op.create_table, so its foreign keys
    # pick up the metadata's naming convention and the create_all-vs-alembic parity
    # test stays green (a hand-written CREATE TABLE emits UNNAMED constraints).
    op.execute(
        sa.text(
            """
            CREATE TABLE public_repo_scans_stash AS
            SELECT
                p.id + :offset AS set_id, p.requested_by, p.github_repo_id, p.owner,
                p.name, p.full_name, p.html_url, p.default_branch, p.lockfile_path,
                p.lockfile_sha
            FROM public_repo_scans AS p
            """
        ).bindparams(offset=offset)
    )

    # --- panel_jobs: origin replaces the scan_id FK ----------------------------
    with op.batch_alter_table("panel_jobs") as batch:
        batch.add_column(
            sa.Column(
                "origin", sa.String(24), nullable=False, server_default="repo_scan"
            )
        )
    op.execute(
        sa.text(
            "UPDATE panel_jobs SET origin = "
            "CASE WHEN scan_id IS NULL THEN 'watchlist' ELSE 'repo_scan' END"
        )
    )
    with op.batch_alter_table("panel_jobs") as batch:
        batch.drop_column("scan_id")

    # --- alerts: verdict -> outcome, kind -> origin ----------------------------
    op.execute(sa.text("UPDATE alerts SET message = '' WHERE message IS NULL"))
    with op.batch_alter_table("alerts") as batch:
        batch.alter_column("verdict", new_column_name="outcome")
        batch.alter_column(
            "kind", new_column_name="origin", type_=sa.String(24), existing_nullable=False
        )
        batch.alter_column(
            "message",
            existing_type=sa.Text(),
            nullable=False,
            server_default="",
        )
    op.execute(
        sa.text(
            "UPDATE alerts SET origin = CASE origin "
            "WHEN 'scan' THEN 'repo_scan' WHEN 'watch' THEN 'watchlist' "
            "ELSE origin END"
        )
    )

    # --- retire the collapsed tables ------------------------------------------
    op.drop_index("ix_public_repo_scan_items_pkg", table_name="public_repo_scan_items")
    op.drop_table("public_repo_scan_items")
    op.drop_index("ix_public_repo_scans_active", table_name="public_repo_scans")
    op.drop_index("ix_public_repo_scans_installation", table_name="public_repo_scans")
    op.drop_table("public_repo_scans")
    op.create_table(
        "public_repo_scans",
        sa.Column(
            "set_id",
            sa.BigInteger,
            sa.ForeignKey("audit_sets.id", ondelete="CASCADE"),
            primary_key=True,
            autoincrement=False,
        ),
        sa.Column(
            "requested_by",
            sa.BigInteger,
            sa.ForeignKey("gh_users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("github_repo_id", sa.BigInteger, nullable=False),
        sa.Column("owner", sa.String(255), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(511), nullable=False),
        sa.Column("html_url", sa.Text, nullable=False),
        sa.Column("default_branch", sa.String(255), nullable=False),
        sa.Column("lockfile_path", sa.Text, nullable=False),
        sa.Column("lockfile_sha", sa.String(64), nullable=False),
    )
    op.create_index("ix_public_repo_scans_repo", "public_repo_scans", ["github_repo_id"])
    op.execute(
        sa.text(
            """
            INSERT INTO public_repo_scans (
                set_id, requested_by, github_repo_id, owner, name, full_name,
                html_url, default_branch, lockfile_path, lockfile_sha
            )
            SELECT
                set_id, requested_by, github_repo_id, owner, name, full_name,
                html_url, default_branch, lockfile_path, lockfile_sha
            FROM public_repo_scans_stash
            """
        )
    )
    op.execute(sa.text("DROP TABLE public_repo_scans_stash"))
    op.drop_index("ix_scan_items_pkg", table_name="scan_items")
    op.drop_table("scan_items")
    op.drop_index("ix_scans_repo_id", table_name="scans")
    op.drop_table("scans")

    # Postgres BIGSERIAL: the explicit ids above bypassed the sequence, so the next
    # INSERT would collide. sqlite's rowid alias derives max(id) on the fly and
    # needs nothing.
    if bind.dialect.name == "postgresql":
        op.execute(
            sa.text(
                "SELECT setval(pg_get_serial_sequence('audit_sets', 'id'), "
                "GREATEST((SELECT COALESCE(MAX(id), 0) FROM audit_sets), 1))"
            )
        )


def downgrade() -> None:
    # One-way: `audit_sets` holds no `status`/counter columns to reconstruct the two
    # old tables from without recomputing every rollup, and the dropped `error` /
    # `full_name_lower` / `scan_id` values are gone. Restore from a snapshot.
    raise NotImplementedError(
        "0006 is not reversible — the collapsed tables' derived counters and the "
        "dropped producerless columns cannot be reconstructed. Restore a snapshot."
    )
