"""Proving that the person attesting actually owns the npm package.

World ID answers *"is a unique human present, consenting to this tarball?"*. It
says nothing about *which* packages that human may speak for. This module
answers the second question, and the two are joined only server-side.

The link is the package's own `repository` field: resolve it to `owner/repo` and
require that the signed-in GitHub user has **push** access. That is the same
authority npm's own provenance/trusted-publishing model leans on, and it reuses
the OAuth the panel already has.

The join key stored against a release is the World **nullifier**, never the
GitHub login — GitHub accounts get compromised too, and the continuity signal
must survive that.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import httpx
import structlog

log = structlog.get_logger(__name__)

NPM_REGISTRY = "https://registry.npmjs.org"

# github:owner/repo | https://github.com/owner/repo(.git) | git+ssh://git@github.com/owner/repo
_GITHUB_REPO = re.compile(
    r"(?:github\.com[:/]|^github:)(?P<owner>[\w.-]+)/(?P<repo>[\w.-]+?)(?:\.git)?/?$",
    re.IGNORECASE,
)


class OwnershipError(RuntimeError):
    """Ownership could not be established. Never assumed on failure."""


@dataclass(frozen=True)
class RepoRef:
    owner: str
    repo: str

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"


def parse_repository(repository: Any) -> RepoRef | None:
    """Extract ``owner/repo`` from an npm ``repository`` field.

    Accepts the string form and the ``{"type","url"}`` object form, and the
    several URL spellings npm tolerates. Returns None when the package names no
    GitHub repository — which is a refusal to attest, not a pass.
    """
    url = repository.get("url") if isinstance(repository, dict) else repository
    if not isinstance(url, str) or not url:
        return None
    match = _GITHUB_REPO.search(url.strip())
    if match is None:
        return None
    return RepoRef(owner=match["owner"], repo=match["repo"])


async def package_repository(
    package_name: str, *, client: httpx.AsyncClient | None = None, registry: str = NPM_REGISTRY
) -> RepoRef | None:
    """The GitHub repo a package declares, from the npm packument."""
    url = f"{registry}/{package_name}"
    if client is not None:
        response = await client.get(url, timeout=20.0)
    else:
        async with httpx.AsyncClient(timeout=20.0) as owned:
            response = await owned.get(url)
    if response.status_code == 404:
        raise OwnershipError(f"npm has no package named {package_name}")
    response.raise_for_status()
    data = response.json()
    return parse_repository(data.get("repository"))


async def user_can_push(octokit: Any, ref: RepoRef) -> bool:
    """Does this user's token grant push access to the repo?

    Read access is not enough: anyone can read a public repo, so accepting it
    would let any GitHub user attest any public package. ``permissions.push``
    is only present on a token-authenticated read, which is exactly the check.
    """
    response = await octokit.rest.repos.async_get(owner=ref.owner, repo=ref.repo)
    permissions = getattr(response.parsed_data, "permissions", None)
    if permissions is None:
        return False
    return bool(getattr(permissions, "push", False) or getattr(permissions, "admin", False))


async def verify_ownership(
    package_name: str,
    octokit: Any,
    *,
    client: httpx.AsyncClient | None = None,
    registry: str = NPM_REGISTRY,
) -> RepoRef:
    """Establish that this user may attest this package, or raise.

    Every failure mode is a refusal with a distinct message, because "we could
    not tell" and "you do not have access" are different things to a maintainer
    staring at the screen.
    """
    ref = await package_repository(package_name, client=client, registry=registry)
    if ref is None:
        raise OwnershipError(
            f"{package_name} declares no GitHub repository, so ownership cannot be proven"
        )
    try:
        allowed = await user_can_push(octokit, ref)
    except Exception as exc:
        raise OwnershipError(f"could not read {ref.full_name} from GitHub: {exc}") from exc
    if not allowed:
        raise OwnershipError(f"you do not have push access to {ref.full_name}")
    return ref
