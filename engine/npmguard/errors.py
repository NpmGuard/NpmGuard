from typing import Any

from kit_spine import KitError

# INVARIANT: every class declared here is constructed somewhere in `npmguard/`.
# `code` is what clients branch on and is stable forever (kit_spine/errors.py),
# so a declared-but-unraisable member forces every exhaustive handling table to
# carry an arm no engine can ever produce. A code without a producer is deleted,
# not declared. Enforced by tests/test_error_taxonomy.py, which reads the
# construction sites out of the package with `ast` rather than trusting a grep.
# `NpmGuardError` is the one exemption and is checked separately: it is never
# raised, and NPMGUARD-9999 reaches the wire as a literal from the
# non-NpmGuardError fallback (service.py, api.py).
#
# RETIRED — reserved, never recycled. Re-using one of these numbers for a new
# meaning silently changes what a client that already branches on it believes:
#   NPMGUARD-0002  ValidationError      request validation is Pydantic plus
#                                       kit_spine's RequestValidationError
#                                       handler (api.py); nothing raised this in
#                                       the Python engine or in the TypeScript
#                                       one it was ported from.
#   NPMGUARD-0010  LLMUnavailableError  provider exhaustion surfaces as kit's
#                                       EndOfRope/OutputInvalid and crosses the
#                                       wire as AuditIncompleteError (0031), or
#                                       as an explicitly degraded intent.
#   NPMGUARD-0050  SessionLimitError    the running-count session cap was
#                                       replaced by the bounded wait queue and a
#                                       fixed worker pool (07f46fd); the
#                                       admission bound that remains is
#                                       QueueFullError (0040).


class NpmGuardError(KitError):
    code = "NPMGUARD-9999"
    http_status = 500
    retryable = False

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        stage: str | None = None,
    ) -> None:
        super().__init__(message, details=details)
        self.stage = stage


class PackageNotFoundError(NpmGuardError):
    code = "NPMGUARD-0001"
    http_status = 404

    def __init__(self, package_name: str) -> None:
        super().__init__(f'Package "{package_name}" not found on npm registry')


class PackageTooLargeError(NpmGuardError):
    """The package needs more FLAG model calls than `max_source_files` allows.

    A REFUSAL, not a truncation: FLAG issues at most one triage call per file in
    `phases.flag_source_files` (an empty file and a >500 KB file are answered without
    a model, so the count is the worst case, not the exact one), and reading the first
    N of 3953 files would let a payload in any unread file reach a `SAFE` verdict —
    a coverage gap wearing a green badge. Non-retryable because the
    input is what is out of bounds — nothing about waiting changes it, and a
    retryable 413 would tell a client to loop forever (see test_error_taxonomy C5).
    413 rather than 400: the request is well-formed, the *entity* it resolves to is
    too large, which is exactly what 413 means.
    """

    code = "NPMGUARD-0003"
    http_status = 413
    retryable = False

    def __init__(self, package_name: str, source_files: int, bound: int) -> None:
        # No `stage`: this is not a phase that failed. Inventory succeeded and FLAG
        # never started, so naming either would send a reader to the wrong place —
        # the same reason QueueFullError carries none.
        super().__init__(
            f'Package "{package_name}" has {source_files} source files to analyse, over the '
            f"{bound}-file bound (NPMGUARD_MAX_SOURCE_FILES). Refused before any model "
            "call rather than analysed in part — a partial read cannot yield a verdict.",
            details={"sourceFiles": source_files, "maxSourceFiles": bound},
        )


class DockerUnavailableError(NpmGuardError):
    code = "NPMGUARD-0020"
    http_status = 503
    retryable = True

    def __init__(self) -> None:
        super().__init__("Docker daemon not reachable")


class AuditTimeoutError(NpmGuardError):
    code = "NPMGUARD-0030"
    http_status = 504
    retryable = True

    def __init__(self, phase: str, timeout_ms: int) -> None:
        super().__init__(f'Phase "{phase}" timed out after {timeout_ms}ms', stage=phase)


class AuditIncompleteError(NpmGuardError):
    code = "NPMGUARD-0031"
    http_status = 503
    retryable = True

    def __init__(self, stage: str, detail: str) -> None:
        super().__init__(f"Audit incomplete ({stage}): {detail}", stage=stage)


class QueueFullError(NpmGuardError):
    code = "NPMGUARD-0040"
    http_status = 503
    retryable = True

    def __init__(self) -> None:
        super().__init__("Audit queue is full — try again shortly")
