from typing import Any

from kit_spine import KitError


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


class ValidationError(NpmGuardError):
    code = "NPMGUARD-0002"
    http_status = 400


class LLMUnavailableError(NpmGuardError):
    code = "NPMGUARD-0010"
    http_status = 503
    retryable = True


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


class SessionLimitError(NpmGuardError):
    code = "NPMGUARD-0050"
    http_status = 503
    retryable = True

    def __init__(self) -> None:
        super().__init__("Too many concurrent audit sessions")
