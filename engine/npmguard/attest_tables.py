"""Tables for publisher attestation.

Conventions match ``persistence.py`` / ``panel/tables.py``: shared
``kit_spine.db.metadata``, ISO-string timestamps written via ``now_iso()``
(never a SQL DEFAULT), and a sqlite-compatible surrogate PK.

Three entities, deliberately separate:

``enrolments``
    Durable, keyed by World nullifier. What Identity Check established about a
    *human* — document-backed, 18+ — which is a property of the person, not of
    any release. Established once and looked up per release, because re-scanning
    a passport for every publish proves nothing new and (since ``IdentityCheck``
    accepts no ``signal``) could not be bound to the artifact anyway.


``attest_sessions``
    Short-lived. One attempt by one signed-in GitHub user to attest one release.
    Holds the resolved artifact and the signal the engine will demand — the
    signal is stored at creation so verification compares against what WE
    decided, never against anything the client later sends back.

``attestations``
    The durable record. Unique on ``(package_name, version)`` so a release can
    be attested exactly once, matching the on-chain registry's append-only rule;
    indexed on ``nullifier`` because the continuity signal reads "every release
    by this publisher".
"""

from __future__ import annotations

import sqlalchemy as sa

from kit_spine.db import metadata


def _surrogate_pk() -> sa.BigInteger:
    """BIGSERIAL on postgres, INTEGER-rowid on sqlite — see panel/tables.py."""
    return sa.BigInteger().with_variant(sa.Integer(), "sqlite")


attest_sessions = sa.Table(
    "attest_sessions",
    metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("package_name", sa.String(214), nullable=False),
    sa.Column("version", sa.String(128), nullable=False),
    # npm's own dist.integrity for the resolved tarball. The artifact binding
    # starts here: everything downstream quotes this value.
    sa.Column("integrity", sa.Text, nullable=False),
    # The GitHub user who proved push access. NULL until ownership is verified,
    # which is what gates the transition out of 'created'.
    sa.Column("github_user_id", sa.String(64), nullable=True),
    sa.Column("github_login", sa.String(255), nullable=True),
    # The signal the engine will demand, computed and frozen at ownership time.
    sa.Column("signal", sa.Text, nullable=True),
    # created -> owned -> verified | failed
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("error", sa.String(512), nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("updated_at", sa.String(64), nullable=False),
    sa.Index("ix_attest_sessions_pkg", "package_name", "version"),
)


enrolments = sa.Table(
    "enrolments",
    metadata,
    # The World nullifier IS the identity here — there is no other key, and that
    # is the point. Enrolment says "the human behind pseudonym N holds a
    # document-backed credential"; it never learns who that human is.
    sa.Column("nullifier", sa.String(128), primary_key=True),
    sa.Column("tier", sa.Integer, nullable=False),
    # Which attributes World attested, as BOOLEANS. Attribute values are never
    # stored — that is the whole minimization claim, and `build_envelope`
    # enforces it for anything published.
    sa.Column("assertions", sa.JSON, nullable=False),
    sa.Column("environment", sa.String(16), nullable=False),
    # The action the enrolment nullifier was scoped to. Recorded because the
    # nullifier is only comparable to a release proof's nullifier when both were
    # scoped identically — if the action ever changed, old enrolments silently
    # stop matching and this column is what makes that visible instead of
    # mysterious.
    sa.Column("action", sa.String(128), nullable=False),
    sa.Column("enrolled_at", sa.String(64), nullable=False),
    sa.Column("updated_at", sa.String(64), nullable=False),
)


attestations = sa.Table(
    "attestations",
    metadata,
    sa.Column("id", _surrogate_pk(), primary_key=True, autoincrement=True),
    sa.Column("package_name", sa.String(214), nullable=False),
    sa.Column("version", sa.String(128), nullable=False),
    sa.Column("integrity", sa.Text, nullable=False),
    # The World ID per-app/per-action pseudonym — the durable publisher
    # identity. Deliberately NOT a name, a wallet or a GitHub login: all three
    # get compromised, and this one is what the continuity signal keys on.
    sa.Column("nullifier", sa.String(128), nullable=False),
    sa.Column("tier", sa.Integer, nullable=False),
    # Per-attribute BOOLEAN assertions ({"minimum_age>=18": true}). Attribute
    # values must never be stored — enforced in attestations.build_envelope.
    sa.Column("assertions", sa.JSON, nullable=False),
    # Which World environment produced the proof. A staging attestation carries
    # no real-world assurance, so every reader must be able to tell.
    sa.Column("environment", sa.String(16), nullable=False),
    sa.Column("github_login", sa.String(255), nullable=True),
    # 0G Storage root of the public envelope + the 0G Chain registry tx. Both
    # nullable: publishing is best-effort and must not gate the local record.
    sa.Column("storage_root", sa.String(128), nullable=True),
    sa.Column("chain_tx", sa.String(128), nullable=True),
    sa.Column("attested_at", sa.String(64), nullable=False),
    # One attestation per release, mirroring the registry's append-only rule.
    sa.UniqueConstraint("package_name", "version", name="uq_attestations_release"),
    # "every release by this publisher" — the continuity read path.
    sa.Index("ix_attestations_nullifier", "nullifier"),
    sa.Index("ix_attestations_package", "package_name"),
)
