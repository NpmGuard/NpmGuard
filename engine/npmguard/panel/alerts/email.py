"""DANGEROUS-verdict email (port of TS ``alerts/email.ts``, nodemailer → SMTP).

The 3am-malware case must reach a human even when nobody is watching the PR.
Configuration over a vendor SDK (repo rule): a single ``NPMGUARD_SMTP_URL``
drives an :mod:`aiosmtplib` transport. Without it the alert still lands on the
dashboard — email is purely additive, and its absence is logged, never fatal.

``aiosmtplib`` is imported lazily inside :func:`send_dangerous_email` so this
module (and the alert logic that imports it) loads even where the dependency or
SMTP config is absent — the common "dashboard-only" path never touches it.
"""

from __future__ import annotations

from email.message import EmailMessage
from urllib.parse import quote, urlsplit

import structlog

from npmguard.config import Settings

log = structlog.get_logger("npmguard.panel.email")


def _build_message(
    settings: Settings,
    org: str,
    recipients: list[str],
    package_name: str,
    version: str,
    exposure_lines: list[str],
) -> EmailMessage:
    report_url = f"{settings.panel_base_url.rstrip('/')}/package/{quote(package_name)}"
    dashboard_url = f"{settings.panel_base_url.rstrip('/')}/dashboard"
    body = "\n".join(
        [
            f"NpmGuard's audit found {package_name}@{version} to be DANGEROUS.",
            "",
            "Exposure:",
            *[f"  - {line}" for line in exposure_lines],
            "",
            f"Full report: {report_url}",
            f"Dashboard: {dashboard_url}",
        ]
    )
    message = EmailMessage()
    message["From"] = settings.alert_from
    message["To"] = ", ".join(recipients)
    message["Subject"] = (
        f"[NpmGuard] DANGEROUS: {package_name}@{version} affects {org}"
    )
    message.set_content(body)
    return message


async def send_dangerous_email(
    settings: Settings,
    org: str,
    recipients: list[str],
    package_name: str,
    version: str,
    exposure_lines: list[str],
) -> None:
    """Send one DANGEROUS alert email to an org's known recipients.

    No-ops (logged, never raised) when SMTP is unconfigured or the org has no
    users with a known email. A send failure is logged and swallowed — an alert
    row already exists on the dashboard.
    """
    if not settings.smtp_url:
        log.info("smtp not configured — dashboard-only alert", org=org)
        return
    if not recipients:
        log.info("no recipients with known emails", org=org)
        return

    message = _build_message(
        settings, org, recipients, package_name, version, exposure_lines
    )
    parts = urlsplit(settings.smtp_url)
    use_tls = parts.scheme == "smtps"
    try:
        import aiosmtplib

        await aiosmtplib.send(
            message,
            hostname=parts.hostname or "localhost",
            port=parts.port or (465 if use_tls else 587),
            username=parts.username or None,
            password=parts.password or None,
            use_tls=use_tls,
            start_tls=None if use_tls else True,
        )
        log.info(
            "dangerous alert email sent",
            package=package_name,
            version=version,
            org=org,
            recipients=len(recipients),
        )
    except Exception as err:  # noqa: BLE001 - email is additive; never fatal
        log.warning("dangerous alert email failed", org=org, error=str(err))


__all__ = ["send_dangerous_email"]
