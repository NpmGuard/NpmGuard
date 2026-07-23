"""Structured logging: JSON lines with named fields, request id bound via
contextvars. Secrets and tokens never appear in logs (UNENFORCED — upheld
by call-site discipline; no redaction processor exists yet)."""

import logging

import structlog

VALID_LEVELS = ("debug", "info", "warning", "error", "critical")


def setup_logging(level: str = "info") -> None:
    if level not in VALID_LEVELS:
        # a bad config kills the process with a clear message — a silent
        # INFO fallback would hide the typo forever (CONVENTIONS.md)
        raise ValueError(f"log level must be one of {VALID_LEVELS}, got {level!r}")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper())
        ),
        cache_logger_on_first_use=True,
    )
