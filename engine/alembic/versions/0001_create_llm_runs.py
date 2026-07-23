"""create llm tables (runs, attempts)

Alembic revision fragment — kit add places this in your app's
alembic/versions/; set down_revision to your current head.
"""

import sqlalchemy as sa

from alembic import op

revision = "kit_llm_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("context_kind", sa.String(32), nullable=False),
        sa.Column("context_id", sa.String(64), nullable=False),
        sa.Column("role", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("steps", sa.Integer, nullable=False),
        sa.Column("total_cost_usd", sa.Float, nullable=True),
        sa.Column("created_at", sa.String(64), nullable=False),
        sa.Column("finished_at", sa.String(64), nullable=True),
        sa.Index("ix_llm_runs_context", "context_kind", "context_id"),
    )
    op.create_table(
        "llm_attempts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("llm_runs.id"), nullable=False),
        sa.Column("step", sa.Integer, nullable=False),
        sa.Column("attempt", sa.Integer, nullable=False),
        sa.Column("model", sa.String(128), nullable=True),
        sa.Column("prompt_version", sa.Integer, nullable=True),
        sa.Column("prompt_hash", sa.String(12), nullable=True),
        sa.Column("messages", sa.JSON, nullable=False),
        sa.Column("tools", sa.JSON, nullable=True),
        sa.Column("output", sa.JSON, nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error", sa.String(1024), nullable=True),
        sa.Column("in_tokens", sa.Integer, nullable=True),
        sa.Column("out_tokens", sa.Integer, nullable=True),
        sa.Column("cached_tokens", sa.Integer, nullable=True),
        sa.Column("cost_usd", sa.Float, nullable=True),
        sa.Column("provider_call_id", sa.String(128), nullable=True),
        sa.Column("latency_ms", sa.Integer, nullable=False),
        sa.Column("request_id", sa.String(64), nullable=True),
        sa.Column("ts", sa.String(64), nullable=False),
        sa.Index("ix_llm_attempts_run_id", "run_id"),
        sa.Index("ix_llm_attempts_ts", "ts"),
    )


def downgrade() -> None:
    op.drop_table("llm_attempts")
    op.drop_table("llm_runs")
