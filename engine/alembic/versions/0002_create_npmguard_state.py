"""create durable audit sessions and payment claims"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_state_0002"
down_revision = "kit_stream_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audit_sessions",
        sa.Column("audit_id", sa.String(36), primary_key=True),
        sa.Column("package_name", sa.String(214), nullable=False),
        sa.Column("requested_version", sa.String(128), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("package_path", sa.Text, nullable=True),
        sa.Column("file_contents", sa.JSON, nullable=True),
        sa.Column("report", sa.JSON, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.String(64), nullable=False),
    )
    op.create_index("ix_audit_sessions_status", "audit_sessions", ["status"])
    op.create_table(
        "payment_claims",
        sa.Column("provider", sa.String(32), primary_key=True),
        sa.Column("payment_key", sa.String(128), primary_key=True),
        sa.Column(
            "audit_id", sa.String(36), sa.ForeignKey("audit_sessions.audit_id"), nullable=False
        ),
        sa.Column("package_name", sa.String(214), nullable=False),
        sa.Column("version", sa.String(128), nullable=False),
        sa.Column("requester", sa.String(128), nullable=True),
        sa.Column("created_at", sa.String(64), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("payment_claims")
    op.drop_index("ix_audit_sessions_status", table_name="audit_sessions")
    op.drop_table("audit_sessions")
