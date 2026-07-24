"""create GitHub repo panel state

Mirrors the SQLAlchemy-core tables declared in npmguard/panel/tables.py so a
migrated database is byte-for-byte equivalent to non-prod metadata.create_all
(the kit substitution rule enforced by the create_all-vs-alembic parity test).
The whole panel is gated behind Settings.github_app_enabled at runtime; the
schema is created unconditionally and simply sits empty when the App is off.
"""

import sqlalchemy as sa

from alembic import op


def _surrogate_pk() -> sa.BigInteger:
    # BIGSERIAL on postgres, INTEGER (rowid autoincrement) on sqlite — a plain
    # BigInteger autoincrement PK does not auto-generate on sqlite. Mirrors
    # npmguard/panel/tables._surrogate_pk so create_all and this migration match.
    return sa.BigInteger().with_variant(sa.Integer(), "sqlite")


revision = "npmguard_panel_0005"
down_revision = "npmguard_llm_widen_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "gh_users",
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

    op.create_table(
        "gh_sessions",
        sa.Column("token", sa.String(64), primary_key=True),
        sa.Column(
            "user_id",
            sa.BigInteger,
            sa.ForeignKey("gh_users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.String(64), nullable=False),
    )
    op.create_index("ix_gh_sessions_user_id", "gh_sessions", ["user_id"])

    op.create_table(
        "installations",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=False),
        sa.Column("account_login", sa.String(255), nullable=False),
        sa.Column("account_type", sa.String(32), nullable=False),
        sa.Column("suspended", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.String(64), nullable=False),
    )

    op.create_table(
        "user_installations",
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

    op.create_table(
        "repos",
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
        sa.Column("protected_at", sa.String(64), nullable=True),
        sa.Column("lockfile_path", sa.Text, nullable=True),
        sa.Column("lockfile_sha", sa.String(64), nullable=True),
        sa.Column("auditability_checked_at", sa.String(64), nullable=True),
        sa.Column("created_at", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.String(64), nullable=False),
    )
    op.create_index("ix_repos_installation_id", "repos", ["installation_id"])

    op.create_table(
        "repo_deps",
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
    )
    op.create_index("ix_repo_deps_name", "repo_deps", ["name"])

    op.create_table(
        "scans",
        sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
        sa.Column(
            "repo_id",
            sa.BigInteger,
            sa.ForeignKey("repos.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("trigger_kind", sa.String(16), nullable=False),
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
    )
    op.create_index("ix_scans_repo_id", "scans", ["repo_id", "started_at"])

    op.create_table(
        "scan_items",
        sa.Column(
            "scan_id",
            sa.BigInteger,
            sa.ForeignKey("scans.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("name", sa.String(214), primary_key=True),
        sa.Column("version", sa.String(128), primary_key=True),
        sa.Column("cached", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_scan_items_pkg", "scan_items", ["name", "version"])

    op.create_table(
        "package_verdicts",
        sa.Column("name", sa.String(214), primary_key=True),
        sa.Column("version", sa.String(128), primary_key=True),
        sa.Column("verdict", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text, nullable=False, server_default=""),
        sa.Column("evidence_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("audited_at", sa.String(64), nullable=False),
    )

    op.create_table(
        "panel_jobs",
        sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
        sa.Column("kind", sa.String(32), nullable=False, server_default="audit_package"),
        sa.Column("lane", sa.String(16), nullable=False, server_default="cheap"),
        sa.Column("org", sa.String(255), nullable=True),
        sa.Column(
            "scan_id",
            sa.BigInteger,
            sa.ForeignKey("scans.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("package_name", sa.String(214), nullable=False),
        sa.Column("version", sa.String(128), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.String(64), nullable=False),
        sa.Column("started_at", sa.String(64), nullable=True),
        sa.Column("finished_at", sa.String(64), nullable=True),
    )
    op.create_index("ix_panel_jobs_state", "panel_jobs", ["state", "lane", "created_at"])
    op.create_index(
        "ix_panel_jobs_active_pkg",
        "panel_jobs",
        ["package_name", "version"],
        unique=True,
        postgresql_where=sa.text("state IN ('queued','running')"),
        sqlite_where=sa.text("state IN ('queued','running')"),
    )

    op.create_table(
        "watched_packages",
        sa.Column("name", sa.String(214), primary_key=True),
        sa.Column("etag", sa.String(255), nullable=True),
        sa.Column("known_versions", sa.Text, nullable=False, server_default="[]"),
        sa.Column("last_checked_at", sa.String(64), nullable=True),
        sa.Column("created_at", sa.String(64), nullable=False),
    )

    op.create_table(
        "billing_accounts",
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

    op.create_table(
        "account_usage",
        sa.Column(
            "installation_id",
            sa.BigInteger,
            sa.ForeignKey("installations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("month", sa.String(7), primary_key=True),
        sa.Column("audits", sa.Integer, nullable=False, server_default="0"),
    )

    op.create_table(
        "alerts",
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
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("message", sa.Text, nullable=True),
        sa.Column("seen", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.String(64), nullable=False),
    )
    op.create_index("ix_alerts_org", "alerts", ["org", "created_at"])

    op.create_table(
        "public_repo_scans",
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
    )
    op.create_index(
        "ix_public_repo_scans_installation",
        "public_repo_scans",
        ["installation_id", "started_at"],
    )
    op.create_index(
        "ix_public_repo_scans_active",
        "public_repo_scans",
        ["installation_id", "full_name_lower"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
        sqlite_where=sa.text("status = 'running'"),
    )

    op.create_table(
        "public_repo_scan_items",
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
    )
    op.create_index(
        "ix_public_repo_scan_items_pkg",
        "public_repo_scan_items",
        ["name", "version"],
    )


def downgrade() -> None:
    op.drop_table("public_repo_scan_items")
    op.drop_index("ix_public_repo_scans_active", table_name="public_repo_scans")
    op.drop_index("ix_public_repo_scans_installation", table_name="public_repo_scans")
    op.drop_table("public_repo_scans")
    op.drop_index("ix_alerts_org", table_name="alerts")
    op.drop_table("alerts")
    op.drop_table("account_usage")
    op.drop_table("billing_accounts")
    op.drop_table("watched_packages")
    op.drop_index("ix_panel_jobs_active_pkg", table_name="panel_jobs")
    op.drop_index("ix_panel_jobs_state", table_name="panel_jobs")
    op.drop_table("panel_jobs")
    op.drop_table("package_verdicts")
    op.drop_index("ix_scan_items_pkg", table_name="scan_items")
    op.drop_table("scan_items")
    op.drop_index("ix_scans_repo_id", table_name="scans")
    op.drop_table("scans")
    op.drop_index("ix_repo_deps_name", table_name="repo_deps")
    op.drop_table("repo_deps")
    op.drop_index("ix_repos_installation_id", table_name="repos")
    op.drop_table("repos")
    op.drop_table("user_installations")
    op.drop_table("installations")
    op.drop_index("ix_gh_sessions_user_id", table_name="gh_sessions")
    op.drop_table("gh_sessions")
    op.drop_table("gh_users")
