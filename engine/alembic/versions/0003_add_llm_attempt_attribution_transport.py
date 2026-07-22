"""add llm_attempts attribution + output transport columns

Brings the vendored kit_llm capture schema (kit_llm migrations 0001 attribution
columns + 0002 transport) onto an existing npmguard database. Fresh databases
get these from metadata.create_all; this migrates deployed ones.
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_llm_transport_0003"
down_revision = "npmguard_state_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "llm_attempts",
        sa.Column("cost_lookup_attempts", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column("llm_attempts", sa.Column("actual_model", sa.Text, nullable=True))
    op.add_column("llm_attempts", sa.Column("provider", sa.Text, nullable=True))
    op.add_column("llm_attempts", sa.Column("finish_reason", sa.Text, nullable=True))
    op.add_column("llm_attempts", sa.Column("transport", sa.Text, nullable=True))


def downgrade() -> None:
    for name in ("transport", "finish_reason", "provider", "actual_model", "cost_lookup_attempts"):
        op.drop_column("llm_attempts", name)
