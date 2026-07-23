"""widen llm_attempts capture columns to match kit_llm code

kit_llm/capture.py widened six columns in code (model, provider_call_id,
request_id -> Text; in_tokens, out_tokens, cached_tokens -> BigInteger) so an
already-paid call is never lost to a length limit or the INTEGER token
ceiling — but no migration shipped the change. Fresh databases get the wide
types from metadata.create_all; this migrates deployed ones. batch_alter_table
recreates the table on SQLite (which cannot ALTER a column type) and emits
plain ALTER COLUMN on PostgreSQL.
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_llm_widen_0004"
down_revision = "npmguard_llm_transport_0003"
branch_labels = None
depends_on = None

_WIDENED = [
    ("model", sa.String(128), sa.Text()),
    ("in_tokens", sa.Integer(), sa.BigInteger()),
    ("out_tokens", sa.Integer(), sa.BigInteger()),
    ("cached_tokens", sa.Integer(), sa.BigInteger()),
    ("provider_call_id", sa.String(128), sa.Text()),
    ("request_id", sa.String(64), sa.Text()),
]


def upgrade() -> None:
    with op.batch_alter_table("llm_attempts") as batch:
        for name, narrow, wide in _WIDENED:
            batch.alter_column(name, existing_type=narrow, type_=wide, existing_nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("llm_attempts") as batch:
        for name, narrow, wide in reversed(_WIDENED):
            batch.alter_column(name, existing_type=wide, type_=narrow, existing_nullable=True)
