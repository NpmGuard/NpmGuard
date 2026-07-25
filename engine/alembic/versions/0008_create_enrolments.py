"""Identity Check enrolments, keyed by World nullifier.

What Identity Check establishes is a property of a *human* — document-backed,
over 18 — not of any release. Storing it per release would mean re-scanning a
document on every publish, which proves nothing new and (because the
``IdentityCheck`` preset accepts no ``signal``) could not be bound to the
artifact anyway.

So it lives in its own table keyed by the nullifier, and a release attestation
looks it up. The nullifier is the only identifier here on purpose: the design
target is pseudonymous, unique and document-backed, and knowing who the person
is would defeat it.
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_enrol_0008"
down_revision = "npmguard_attest_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "enrolments",
        sa.Column("nullifier", sa.String(128), primary_key=True),
        sa.Column("tier", sa.Integer, nullable=False),
        # Booleans only. Attribute VALUES are never stored — enforced for
        # anything published by attestations.build_envelope.
        sa.Column("assertions", sa.JSON, nullable=False),
        sa.Column("environment", sa.String(16), nullable=False),
        # The action this nullifier was scoped to. A nullifier is only comparable
        # to another when both were scoped identically, so recording it makes a
        # changed action visible instead of silently orphaning every enrolment.
        sa.Column("action", sa.String(128), nullable=False),
        sa.Column("enrolled_at", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.String(64), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("enrolments")
