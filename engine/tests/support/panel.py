"""Shared panel-enable machinery: the credentials that turn the panel on.

The whole panel is gated behind ``Settings.github_app_enabled``, which is true
only when all five credentials are present. Tests therefore have to supply them
deliberately — the suite-wide conftest disables the dotenv source precisely so
this never happens by accident (see the INVARIANT note there).

Every panel test needs the same five values plus an RSA key on disk for the
App-JWT signing path, so they live here once rather than in each test module.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from npmguard.contract.models import AuditReport, HypothesisCounts

# 32-byte AES-256-GCM key, hex-encoded. Settings only enforces the SHAPE
# (64 hex chars), and no test asserts on ciphertext, so the value is arbitrary.
ENCRYPTION_KEY = "00" * 32


def write_app_private_key(directory: Path) -> str:
    """A throwaway RSA private key on disk → its path.

    The App-JWT path only needs a PEM githubkit can sign with; the GitHub stub
    trusts any Bearer and never verifies the signature.
    """
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    path = directory / "app-key.pem"
    path.write_bytes(pem)
    return str(path)


def github_env(
    *,
    api_base: str,
    private_key_path: str,
    panel_base_url: str,
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    """The env that flips ``github_app_enabled`` to True.

    ``api_base`` points githubkit at a stub (or a dead port) so no test can
    reach api.github.com. ``extra`` layers per-test knobs (webhook secret,
    Stripe, raw-content base) over the shared base.
    """
    env = {
        "NPMGUARD_GITHUB_APP_ID": "12345",
        "NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH": private_key_path,
        "NPMGUARD_GITHUB_CLIENT_ID": "Iv1.testclient",
        "NPMGUARD_GITHUB_CLIENT_SECRET": "test-client-secret",
        "NPMGUARD_ENCRYPTION_KEY": ENCRYPTION_KEY,
        "NPMGUARD_GITHUB_API_BASE": api_base,
        "NPMGUARD_PANEL_BASE_URL": panel_base_url,
    }
    if extra:
        env.update(extra)
    return env


def seed_report(
    reports_dir: Path,
    name: str,
    version: str,
    *,
    verdict: Literal["SAFE", "DANGEROUS"],
    rationale: str = "",
    confirmed: list[str] | None = None,
) -> None:
    """Write a report file the boot-time verdict-index rebuild turns into a
    ``package_verdicts`` cache hit, so the dep needs no real audit.

    Built through the GENERATED contract rather than as a dict literal, because
    the store screens what it hands out: ``report_store._readable`` drops any
    report whose ``schemaVersion``/``verdict`` is outside the contract's domain.
    A literal that omits ``schemaVersion`` is therefore invisible rather than
    rejected — every seeded dep becomes a cache MISS and the scan rolls up ERROR
    instead of the verdict it seeded, which reads as a product bug rather than a
    fixture one. Constructing the model also means a contract change moves the
    fixture with it.
    """
    confirmed_ids = confirmed or []
    report = AuditReport(
        verdict=verdict,
        rationale=rationale,
        counts=HypothesisCounts(
            total=len(confirmed_ids),
            open=0,
            inProgress=0,
            confirmed=len(confirmed_ids),
            refuted=0,
            deferred=0,
        ),
        confirmedHypIds=confirmed_ids,
    )
    directory = reports_dir / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{version}.json").write_text(
        json.dumps(report.model_dump(mode="json")) + "\n", encoding="utf-8"
    )
