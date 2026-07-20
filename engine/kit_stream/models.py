"""The durable event log. Append-only; (channel, seq) is the identity and
the ordering authority. Rows are spine envelopes at rest."""

import sqlalchemy as sa

from kit_spine.db import metadata

stream_events = sa.Table(
    "stream_events",
    metadata,
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
