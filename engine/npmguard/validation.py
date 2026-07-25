import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, model_validator

# The chains this engine can verify a payment on. Lives here, with the rest of
# the request vocabulary, so ``payments`` can take it without validation having
# to import web3.
SupportedChain = Literal["base-sepolia", "base"]

PACKAGE_NAME_RE = re.compile(r"^(@[a-z0-9\-~][a-z0-9._~\-]*/)?[a-z0-9\-~][a-z0-9._~\-]*$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$")
TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


def valid_package_name(value: str) -> str:
    if not 1 <= len(value) <= 214 or PACKAGE_NAME_RE.fullmatch(value) is None:
        raise ValueError("Invalid npm package name")
    return value


def valid_semver(value: str) -> str:
    if SEMVER_RE.fullmatch(value) is None:
        raise ValueError("Invalid semver version")
    return value


def valid_local_path(value: str) -> str:
    """An absolute directory holding a package.json, checked at parse time.

    A path that is relative, missing, or not a package is incoherent — there is
    nothing for resolve to acquire — so it is refused here rather than becoming
    a resolve-phase failure inside an admitted audit. Absolute only: a relative
    path would resolve against the engine process's cwd, which no caller knows.
    """
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("localPath must be absolute")
    if not (path / "package.json").is_file():
        raise ValueError(f"localPath {value} is not a package directory")
    return value


class AuditRequest(BaseModel):
    packageName: str = Field(min_length=1, max_length=214)
    version: str | None = None
    # Where the bytes come from, DECLARED. The package name never implies it —
    # a name is an identity, not a capability. None means the registry.
    localPath: str | None = None

    @model_validator(mode="after")
    def valid(self) -> "AuditRequest":
        valid_package_name(self.packageName)
        if self.version is not None:
            valid_semver(self.version)
        if self.localPath is not None:
            valid_local_path(self.localPath)
        return self


class CheckoutRequest(AuditRequest):
    email: EmailStr | None = None

    @model_validator(mode="after")
    def no_local_path(self) -> "CheckoutRequest":
        # INVARIANT: a paid checkout is always a registry package. Nobody buys an
        # audit of a directory on the engine's own disk, and this is what lets
        # /checkout verify the package exists on npm unconditionally.
        if self.localPath is not None:
            raise ValueError("localPath is not accepted on a checkout")
        return self


class StreamAuditRequest(BaseModel):
    packageName: str | None = None
    version: str | None = None
    localPath: str | None = None
    stripeSessionId: str | None = None
    txHash: str | None = None
    # The chain set is the type, not a validator check: parsing a request is
    # then the only place a chain name can be wrong, and everything downstream
    # (is_chain_configured, verify_audit_payment) takes SupportedChain.
    chain: SupportedChain | None = None

    @model_validator(mode="after")
    def valid(self) -> "StreamAuditRequest":
        if self.packageName is not None:
            valid_package_name(self.packageName)
        if self.version is not None:
            valid_semver(self.version)
        if self.localPath is not None:
            valid_local_path(self.localPath)
        if self.txHash is not None and TX_HASH_RE.fullmatch(self.txHash) is None:
            raise ValueError("Invalid txHash")
        return self
