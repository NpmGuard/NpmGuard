"""SQLAlchemy-core table declarations for the GitHub repo panel.

Every table lives on the shared ``kit_spine.db.metadata`` (like
``npmguard.persistence``) so non-prod ``metadata.create_all`` and alembic
autogenerate both see them. Conventions match ``persistence.py``:

- GitHub-assigned ids (user / installation / repo) are ``BigInteger`` — they
  exceed int32. Surrogate keys are ``BigInteger`` autoincrement.
- Timestamps are ``String(64)`` ISO strings written via ``now_iso()`` — never a
  SQL ``DEFAULT``.
- The load-bearing dedupe indexes (``ix_panel_jobs_active_pkg``,
  ``ix_public_repo_scans_active``) are PARTIAL UNIQUE — both ``postgresql_where``
  and ``sqlite_where`` are supplied for portability across the sqlite/postgres
  engine axis.
- ``public_repo_scans`` carries a stored ``full_name_lower`` column so the
  active-scan uniqueness is case-insensitive on both sqlite and postgres
  (TS's ``COLLATE NOCASE`` isn't portable to postgres).
"""

from __future__ import annotations

import sqlalchemy as sa

from kit_spine.db import metadata


def _surrogate_pk() -> sa.BigInteger:
    """An auto-incrementing surrogate primary key that works on BOTH engines.

    A plain ``BigInteger`` autoincrement PK does NOT auto-generate on sqlite —
    SQLite only aliases the rowid for a column typed exactly ``INTEGER``, so a
    ``BIGINT PRIMARY KEY`` inserts NULL and violates NOT NULL. The variant keeps
    ``BIGSERIAL`` on postgres (GitHub ids never collide with these surrogates)
    while emitting ``INTEGER PRIMARY KEY`` (rowid) on the dev-default sqlite.
    """
    return sa.BigInteger().with_variant(sa.Integer(), "sqlite")


# GitHub identities; id = GitHub user id.
gh_users = sa.Table(
    "gh_users",
    metadata,
    sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=False),
    sa.Column("login", sa.String(255), nullable=False),
    sa.Column("name", sa.String(255), nullable=True),
    sa.Column("email", sa.String(320), nullable=True),
    sa.Column("avatar_url", sa.Text, nullable=True),
    sa.Column("access_token_enc", sa.Text, nullable=True),
    sa.Column("refresh_token_enc", sa.Text, nullable=True),
    sa.Column("token_expires_at", sa.String(64), nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("updated_at", sa.String(64), nullable=False),
)

# Opaque 32-byte-hex session token backing the HttpOnly ng_session cookie.
gh_sessions = sa.Table(
    "gh_sessions",
    metadata,
    sa.Column("token", sa.String(64), primary_key=True),
    sa.Column(
        "user_id",
        sa.BigInteger,
        sa.ForeignKey("gh_users.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("expires_at", sa.String(64), nullable=False),
    sa.Index("ix_gh_sessions_user_id", "user_id"),
)

# id = GitHub installation id.
installations = sa.Table(
    "installations",
    metadata,
    sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=False),
    sa.Column("account_login", sa.String(255), nullable=False),
    sa.Column("account_type", sa.String(32), nullable=False),  # 'Organization' | 'User'
    sa.Column("suspended", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("updated_at", sa.String(64), nullable=False),
)

# Authorization cache: which installations a user can access.
user_installations = sa.Table(
    "user_installations",
    metadata,
    sa.Column(
        "user_id",
        sa.BigInteger,
        sa.ForeignKey("gh_users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column(
        "installation_id",
        sa.BigInteger,
        sa.ForeignKey("installations.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("refreshed_at", sa.String(64), nullable=False),
)

# id = GitHub repo id.
repos = sa.Table(
    "repos",
    metadata,
    sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=False),
    sa.Column(
        "installation_id",
        sa.BigInteger,
        sa.ForeignKey("installations.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("owner", sa.String(255), nullable=False),
    sa.Column("name", sa.String(255), nullable=False),
    sa.Column("full_name", sa.String(511), nullable=False),
    sa.Column("private", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("default_branch", sa.String(255), nullable=False, server_default="main"),
    sa.Column("protected_at", sa.String(64), nullable=True),  # NULL = Protect off
    sa.Column("lockfile_path", sa.Text, nullable=True),
    sa.Column("lockfile_sha", sa.String(64), nullable=True),
    # set + lockfile_path NULL = confirmed non-auditable.
    sa.Column("auditability_checked_at", sa.String(64), nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("updated_at", sa.String(64), nullable=False),
    sa.Index("ix_repos_installation_id", "installation_id"),
)

# The dependency index; registry-watch substrate.
repo_deps = sa.Table(
    "repo_deps",
    metadata,
    sa.Column(
        "repo_id",
        sa.BigInteger,
        sa.ForeignKey("repos.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("name", sa.String(214), primary_key=True),
    sa.Column("version", sa.String(128), primary_key=True),
    sa.Column("direct", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("range", sa.String(255), nullable=True),
    sa.Index("ix_repo_deps_name", "name"),
)

scans = sa.Table(
    "scans",
    metadata,
    sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
    sa.Column(
        "repo_id",
        sa.BigInteger,
        sa.ForeignKey("repos.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("trigger_kind", sa.String(16), nullable=False),  # 'manual'|'push'|'reconcile'
    sa.Column("commit_sha", sa.String(64), nullable=True),
    sa.Column("status", sa.String(16), nullable=False, server_default="running"),
    sa.Column("total", sa.Integer, nullable=False, server_default="0"),
    sa.Column("cached", sa.Integer, nullable=False, server_default="0"),
    sa.Column("audited", sa.Integer, nullable=False, server_default="0"),
    sa.Column("failed", sa.Integer, nullable=False, server_default="0"),
    sa.Column("error", sa.Text, nullable=True),
    sa.Column("check_run_id", sa.BigInteger, nullable=True),
    sa.Column("started_at", sa.String(64), nullable=False),
    sa.Column("finished_at", sa.String(64), nullable=True),
    sa.Index("ix_scans_repo_id", "repo_id", "started_at"),
)

# The exact (pkg, version) set a scan covers — progress computes from THIS.
scan_items = sa.Table(
    "scan_items",
    metadata,
    sa.Column(
        "scan_id",
        sa.BigInteger,
        sa.ForeignKey("scans.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("name", sa.String(214), primary_key=True),
    sa.Column("version", sa.String(128), primary_key=True),
    sa.Column("cached", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Index("ix_scan_items_pkg", "name", "version"),
)

# Derived, rebuildable index of data/reports/. dev: 'SAFE'|'DANGEROUS' only.
package_verdicts = sa.Table(
    "package_verdicts",
    metadata,
    sa.Column("name", sa.String(214), primary_key=True),
    sa.Column("version", sa.String(128), primary_key=True),
    sa.Column("verdict", sa.String(16), nullable=False),
    sa.Column("reason", sa.Text, nullable=False, server_default=""),
    sa.Column("evidence_count", sa.Integer, nullable=False, server_default="0"),
    sa.Column("audited_at", sa.String(64), nullable=False),
)

# Durable audit-job queue; cross-scan dedupe via the partial unique index.
panel_jobs = sa.Table(
    "panel_jobs",
    metadata,
    sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
    sa.Column("kind", sa.String(32), nullable=False, server_default="audit_package"),
    sa.Column("lane", sa.String(16), nullable=False, server_default="cheap"),
    sa.Column("org", sa.String(255), nullable=True),  # account_login | NULL (watch: not charged)
    sa.Column(
        "scan_id",
        sa.BigInteger,
        sa.ForeignKey("scans.id", ondelete="SET NULL"),
        nullable=True,
    ),  # NULL for public/watch
    sa.Column("package_name", sa.String(214), nullable=False),
    sa.Column("version", sa.String(128), nullable=False),
    sa.Column("state", sa.String(16), nullable=False, server_default="queued"),
    sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
    sa.Column("error", sa.Text, nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("started_at", sa.String(64), nullable=True),
    sa.Column("finished_at", sa.String(64), nullable=True),
    sa.Index("ix_panel_jobs_state", "state", "lane", "created_at"),
    sa.Index(
        "ix_panel_jobs_active_pkg",
        "package_name",
        "version",
        unique=True,
        postgresql_where=sa.text("state IN ('queued','running')"),
        sqlite_where=sa.text("state IN ('queued','running')"),
    ),
)

# Registry-watch state.
watched_packages = sa.Table(
    "watched_packages",
    metadata,
    sa.Column("name", sa.String(214), primary_key=True),
    sa.Column("etag", sa.String(255), nullable=True),
    sa.Column("known_versions", sa.Text, nullable=False, server_default="[]"),  # JSON array
    sa.Column("last_checked_at", sa.String(64), nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
)

# Installation = billing account.
billing_accounts = sa.Table(
    "billing_accounts",
    metadata,
    sa.Column(
        "installation_id",
        sa.BigInteger,
        sa.ForeignKey("installations.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("stripe_customer_id", sa.String(255), unique=True, nullable=True),
    sa.Column("stripe_subscription_id", sa.String(255), unique=True, nullable=True),
    sa.Column("subscription_status", sa.String(32), nullable=False, server_default="inactive"),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("updated_at", sa.String(64), nullable=False),
)

# Monthly audit budget.
account_usage = sa.Table(
    "account_usage",
    metadata,
    sa.Column(
        "installation_id",
        sa.BigInteger,
        sa.ForeignKey("installations.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("month", sa.String(7), primary_key=True),  # 'YYYY-MM'
    sa.Column("audits", sa.Integer, nullable=False, server_default="0"),
)

# Dashboard feed.
alerts = sa.Table(
    "alerts",
    metadata,
    sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
    sa.Column("org", sa.String(255), nullable=False),
    sa.Column(
        "repo_id",
        sa.BigInteger,
        sa.ForeignKey("repos.id", ondelete="SET NULL"),
        nullable=True,
    ),
    sa.Column("package_name", sa.String(214), nullable=False),
    sa.Column("version", sa.String(128), nullable=False),
    sa.Column("verdict", sa.String(16), nullable=False),
    sa.Column("kind", sa.String(16), nullable=False),  # 'scan'|'watch'
    sa.Column("message", sa.Text, nullable=True),
    sa.Column("seen", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Index("ix_alerts_org", "org", "created_at"),
)

# Read-only public-repo audit snapshots; NOT joined to repos.
public_repo_scans = sa.Table(
    "public_repo_scans",
    metadata,
    sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
    sa.Column(
        "installation_id",
        sa.BigInteger,
        sa.ForeignKey("installations.id", ondelete="CASCADE"),
        nullable=False,
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
    # Stored lowercased mirror of full_name for portable case-insensitive
    # active-scan uniqueness (postgres has no COLLATE NOCASE).
    sa.Column("full_name_lower", sa.String(511), nullable=False),
    sa.Column("html_url", sa.Text, nullable=False),
    sa.Column("default_branch", sa.String(255), nullable=False),
    sa.Column("commit_sha", sa.String(64), nullable=True),
    sa.Column("lockfile_path", sa.Text, nullable=False),
    sa.Column("lockfile_sha", sa.String(64), nullable=False),
    sa.Column("status", sa.String(16), nullable=False, server_default="running"),
    sa.Column("total", sa.Integer, nullable=False, server_default="0"),
    sa.Column("cached", sa.Integer, nullable=False, server_default="0"),
    sa.Column("audited", sa.Integer, nullable=False, server_default="0"),
    sa.Column("failed", sa.Integer, nullable=False, server_default="0"),
    sa.Column("error", sa.Text, nullable=True),
    sa.Column("started_at", sa.String(64), nullable=False),
    sa.Column("finished_at", sa.String(64), nullable=True),
    sa.Index("ix_public_repo_scans_installation", "installation_id", "started_at"),
    sa.Index(
        "ix_public_repo_scans_active",
        "installation_id",
        "full_name_lower",
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
        sqlite_where=sa.text("status = 'running'"),
    ),
)

public_repo_scan_items = sa.Table(
    "public_repo_scan_items",
    metadata,
    sa.Column(
        "scan_id",
        sa.BigInteger,
        sa.ForeignKey("public_repo_scans.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    sa.Column("name", sa.String(214), primary_key=True),
    sa.Column("version", sa.String(128), primary_key=True),
    sa.Column("direct", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("range", sa.String(255), nullable=True),
    sa.Column("cached", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Index("ix_public_repo_scan_items_pkg", "name", "version"),
)
