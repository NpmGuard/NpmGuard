"""publisher attestation: attest_sessions + attestations

The World ID layer's durable state. Two tables, deliberately separate: a
short-lived session per attempt, and the append-only record of what was proven.

`attestations` is unique on (package_name, version) to mirror the on-chain
registry's append-only rule — a release is attested exactly once, and a second
attempt is a conflict rather than an overwrite. Rewritable history would let an
attacker who reached the verifier retroactively manufacture a clean publisher
streak, which is the one thing the continuity signal must not permit.

Nothing here stores an identity attribute VALUE: `assertions` holds booleans
only ({"minimum_age>=18": true}), enforced upstream in
attestations.build_envelope.

Revision ID: npmguard_attest_0007
Revises: npmguard_audit_sets_0006
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_attest_0007"
down_revision = "npmguard_audit_sets_0006"
branch_labels = None
depends_on = None


def _surrogate_pk() -> sa.BigInteger:
    return sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "attest_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("package_name", sa.String(214), nullable=False),
        sa.Column("version", sa.String(128), nullable=False),
        sa.Column("integrity", sa.Text, nullable=False),
        sa.Column("github_user_id", sa.String(64), nullable=True),
        sa.Column("github_login", sa.String(255), nullable=True),
        sa.Column("signal", sa.Text, nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error", sa.String(512), nullable=True),
        sa.Column("created_at", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.String(64), nullable=False),
    )
    op.create_index("ix_attest_sessions_pkg", "attest_sessions", ["package_name", "version"])

    op.create_table(
        "attestations",
        sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
        sa.Column("package_name", sa.String(214), nullable=False),
        sa.Column("version", sa.String(128), nullable=False),
        sa.Column("integrity", sa.Text, nullable=False),
        sa.Column("nullifier", sa.String(128), nullable=False),
        sa.Column("tier", sa.Integer, nullable=False),
        sa.Column("assertions", sa.JSON, nullable=False),
        sa.Column("environment", sa.String(16), nullable=False),
        sa.Column("github_login", sa.String(255), nullable=True),
        sa.Column("storage_root", sa.String(128), nullable=True),
        sa.Column("chain_tx", sa.String(128), nullable=True),
        sa.Column("attested_at", sa.String(64), nullable=False),
        sa.UniqueConstraint("package_name", "version", name="uq_attestations_release"),
    )
    op.create_index("ix_attestations_nullifier", "attestations", ["nullifier"])
    op.create_index("ix_attestations_package", "attestations", ["package_name"])


def downgrade() -> None:
    op.drop_index("ix_attestations_package", table_name="attestations")
    op.drop_index("ix_attestations_nullifier", table_name="attestations")
    op.drop_table("attestations")
    op.drop_index("ix_attest_sessions_pkg", table_name="attest_sessions")
    op.drop_table("attest_sessions")
