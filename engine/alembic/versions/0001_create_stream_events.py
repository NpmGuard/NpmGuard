"""create stream_events

Alembic revision fragment — copy into your app's alembic/versions/ and set
down_revision to your current head.
"""

import sqlalchemy as sa

from alembic import op

revision = "kit_stream_0001"
down_revision = "kit_llm_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "stream_events",
        sa.Column("channel", sa.String(63), primary_key=True),
        sa.Column(
            "seq",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            primary_key=True,
            autoincrement=False,
        ),
        sa.Column("type", sa.String(200), nullable=False),
        sa.Column("ts", sa.String(64), nullable=False),
        sa.Column("data", sa.JSON(none_as_null=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("stream_events")
