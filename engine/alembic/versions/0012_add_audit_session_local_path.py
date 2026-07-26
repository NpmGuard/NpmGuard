"""Record where an audit's package bytes came from.

NULL means the registry, which is every audit a public deployment can create.
A non-NULL path is a package staged on the engine's host — a benchmark corpus
entry or a test fixture — and it is the fact that decides two things a package
name used to be asked to imply: how the package is acquired, and whether the
audit belongs on a surface that describes published npm packages.
"""

import sqlalchemy as sa

from alembic import op

revision = "npmguard_audit_local_path_0012"
down_revision = "npmguard_drop_panel_jobs_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("audit_sessions") as batch:
        batch.add_column(sa.Column("local_path", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("audit_sessions") as batch:
        batch.drop_column("local_path")
