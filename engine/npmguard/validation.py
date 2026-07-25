import re
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


class AuditRequest(BaseModel):
    packageName: str = Field(min_length=1, max_length=214)
    version: str | None = None

    @model_validator(mode="after")
    def valid(self) -> "AuditRequest":
        valid_package_name(self.packageName)
        if self.version is not None:
            valid_semver(self.version)
        return self


class CheckoutRequest(AuditRequest):
    email: EmailStr | None = None


class StreamAuditRequest(BaseModel):
    packageName: str | None = None
    version: str | None = None
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
        if self.txHash is not None and TX_HASH_RE.fullmatch(self.txHash) is None:
            raise ValueError("Invalid txHash")
        return self
