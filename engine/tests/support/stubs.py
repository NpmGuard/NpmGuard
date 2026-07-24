"""Deterministic HTTP stubs behind REAL sockets: npm registry, chain RPC, Stripe.

Each stub is a FastAPI app served by a background-thread uvicorn on port 0, so
it works both for the out-of-process e2e engine and for in-process unit tests
(e.g. payments tests pointing web3/stripe at ``base_url``). All stub state is
plain per-instance data — ``clear()`` between tests, never share across files.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import threading
import time
import uuid
from typing import Any
from urllib.parse import parse_qsl

import uvicorn
from eth_abi import encode as abi_encode
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from web3 import Web3

from npmguard.payments import AUDIT_EVENT_TOPIC

STUB_START_TIMEOUT_SECONDS = 10.0

AUDIT_FEE_SELECTOR = bytes(Web3.keccak(text="auditFee()"))[:4]
_METADATA_FORM_KEY = re.compile(r"metadata\[(\w+)\]")
_ZERO_HASH = "0x" + "00" * 32


class StubServer:
    """Threaded uvicorn hosting one ASGI app on 127.0.0.1:0."""

    def __init__(self, app: Any, host: str = "127.0.0.1") -> None:
        self._config = uvicorn.Config(
            app, host=host, port=0, log_level="warning", access_log=False, lifespan="off"
        )
        self._server = uvicorn.Server(self._config)
        self._thread: threading.Thread | None = None
        self.host = host
        self.port: int | None = None

    @property
    def base_url(self) -> str:
        assert self.port is not None, "StubServer not started"
        return f"http://{self.host}:{self.port}"

    def start(self) -> StubServer:
        self._thread = threading.Thread(target=self._server.run, daemon=True)
        self._thread.start()
        deadline = time.monotonic() + STUB_START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if self._server.started and self._server.servers:
                sockets = self._server.servers[0].sockets
                if sockets:
                    self.port = sockets[0].getsockname()[1]
                    return self
            if not self._thread.is_alive():
                raise RuntimeError("stub server thread died during startup")
            time.sleep(0.02)
        raise RuntimeError(f"stub server not up within {STUB_START_TIMEOUT_SECONDS}s")

    def stop(self) -> None:
        self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=10)
            if self._thread.is_alive():
                self._server.force_exit = True
                self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> StubServer:
        return self.start()

    def __exit__(self, *exc_info: object) -> None:
        self.stop()


class _SelfServing:
    """start()/stop()/context-manager plumbing shared by the stub classes."""

    app: FastAPI

    def __init__(self) -> None:
        self._server: StubServer | None = None

    @property
    def base_url(self) -> str:
        assert self._server is not None, f"{type(self).__name__} not started"
        return self._server.base_url

    def start(self):
        self._server = StubServer(self.app).start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.stop()
            self._server = None

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc_info: object) -> None:
        self.stop()


class RegistryStub(_SelfServing):
    """Offline npm registry: packuments + tarballs, 404 for unknown packages.

    ``GET /{name}/{version}`` serves the packument-subset with ``dist.tarball``
    rewritten to this stub's own address; ``version == "latest"`` resolves to
    the highest loaded version. ``GET /-/tarballs/{name}/{filename}`` serves
    the bytes.
    """

    def __init__(self) -> None:
        super().__init__()
        # (name, version) -> {"packument": dict, "tarball": bytes, "filename": str}
        self._packages: dict[tuple[str, str], dict[str, Any]] = {}
        self.app = FastAPI()
        self.app.get("/-/tarballs/{name:path}/{filename}")(self._tarball)
        self.app.get("/{name:path}/{version}")(self._packument)

    def clear(self) -> None:
        self._packages.clear()

    def add_package(self, packument: dict[str, Any], tarball: bytes) -> None:
        name = packument.get("name")
        version = packument.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            raise ValueError("packument must carry string 'name' and 'version'")
        filename = f"{name.replace('/', '-')}-{version}.tgz"
        self._packages[(name, version)] = {
            "packument": packument,
            "tarball": tarball,
            "filename": filename,
        }

    def load_dir(self, path: Any) -> int:
        """Load committed registry fixtures: any ``*.json`` file that parses to a
        packument (has name/version/dist) with its tarball as a sibling file
        named by the basename of ``dist.tarball``. Layout-agnostic on purpose.
        """
        import json
        from pathlib import Path

        loaded = 0
        for candidate in sorted(Path(path).rglob("*.json")):
            try:
                data = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict) or "dist" not in data:
                continue
            if not isinstance(data.get("name"), str) or not isinstance(data.get("version"), str):
                continue
            tarball_url = (data.get("dist") or {}).get("tarball")
            if not isinstance(tarball_url, str):
                continue
            tarball_file = candidate.parent / tarball_url.rsplit("/", 1)[-1]
            if not tarball_file.is_file():
                tgz = sorted(candidate.parent.glob("*.tgz"))
                if len(tgz) != 1:
                    continue
                tarball_file = tgz[0]
            self.add_package(data, tarball_file.read_bytes())
            loaded += 1
        return loaded

    async def _packument(self, name: str, version: str, request: Request) -> Response:
        resolved = version
        if version == "latest":
            versions = [ver for (pkg, ver) in self._packages if pkg == name]
            if not versions:
                return JSONResponse({"error": "Not found"}, status_code=404)
            resolved = max(versions, key=_version_sort_key)
        entry = self._packages.get((name, resolved))
        if entry is None:
            return JSONResponse({"error": "Not found"}, status_code=404)
        base = str(request.base_url).rstrip("/")
        packument = dict(entry["packument"])
        dist = dict(packument.get("dist") or {})
        dist["tarball"] = f"{base}/-/tarballs/{name}/{entry['filename']}"
        packument["dist"] = dist
        return JSONResponse(packument)

    async def _tarball(self, name: str, filename: str) -> Response:
        for (pkg, _), entry in self._packages.items():
            if pkg == name and entry["filename"] == filename:
                return Response(entry["tarball"], media_type="application/octet-stream")
        return JSONResponse({"error": "Not found"}, status_code=404)


def _version_sort_key(version: str) -> tuple:
    parts = version.split("-")[0].split(".")
    try:
        return tuple(int(part) for part in parts)
    except ValueError:
        return (0,)


class FakeChainRpc(_SelfServing):
    """JSON-RPC endpoint for web3: receipts from a tx→receipt map + auditFee.

    Modes per receipt: immediate, delayed (``delay_seconds`` — receipt is null
    until then, exercising the poll loop), reverted (``status=0``), wrong-event
    (valid log under a different topic0), wrong-contract (log emitted by
    another address). A missing tx is simply never added (web3 polls until its
    30s timeout).
    """

    def __init__(self) -> None:
        super().__init__()
        self._receipts: dict[str, dict[str, Any]] = {}  # tx(lower) -> {"receipt", "at"}
        self.audit_fee_wei: int | None = None
        self.requests: list[dict[str, Any]] = []
        self.app = FastAPI()
        self.app.post("/{path:path}")(self._rpc)

    def clear(self) -> None:
        self._receipts.clear()
        self.audit_fee_wei = None
        self.requests.clear()

    def set_audit_fee(self, wei: int) -> None:
        self.audit_fee_wei = wei

    @staticmethod
    def audit_requested_log(
        *,
        contract: str,
        package_name: str,
        version: str,
        requester: str,
        fee_wei: int,
        wrong_event: bool = False,
    ) -> dict[str, Any]:
        topic0 = (
            Web3.keccak(text="SomethingElse(string)").hex()
            if wrong_event
            else AUDIT_EVENT_TOPIC
        )
        requester_hex = Web3.to_checksum_address(requester)[2:].lower()
        data = abi_encode(["string", "string", "uint256"], [package_name, version, fee_wei])
        return {
            "address": contract,
            "topics": [topic0, "0x" + "00" * 12 + requester_hex],
            "data": "0x" + data.hex(),
            "blockNumber": "0x10",
            "transactionHash": _ZERO_HASH,
            "transactionIndex": "0x0",
            "blockHash": _ZERO_HASH,
            "logIndex": "0x0",
            "removed": False,
        }

    def add_receipt(
        self,
        tx_hash: str,
        *,
        contract: str,
        package_name: str,
        version: str,
        requester: str = "0x00000000000000000000000000000000000000A1",
        fee_wei: int = 10**15,
        status: int = 1,
        delay_seconds: float = 0.0,
        wrong_event: bool = False,
        log_address: str | None = None,
        extra_logs: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        log = self.audit_requested_log(
            contract=log_address or contract,
            package_name=package_name,
            version=version,
            requester=requester,
            fee_wei=fee_wei,
            wrong_event=wrong_event,
        )
        log["transactionHash"] = tx_hash
        receipt = {
            "transactionHash": tx_hash,
            "transactionIndex": "0x0",
            "blockHash": _ZERO_HASH,
            "blockNumber": "0x10",
            "from": "0x" + "00" * 20,
            "to": contract,
            "cumulativeGasUsed": "0x5208",
            "gasUsed": "0x5208",
            "contractAddress": None,
            "logs": [*(extra_logs or []), log],
            "logsBloom": "0x" + "00" * 256,
            "status": hex(status),
            "effectiveGasPrice": "0x1",
            "type": "0x2",
        }
        self.add_raw_receipt(tx_hash, receipt, delay_seconds=delay_seconds)
        return receipt

    def add_raw_receipt(
        self, tx_hash: str, receipt: dict[str, Any], *, delay_seconds: float = 0.0
    ) -> None:
        self._receipts[tx_hash.lower()] = {
            "receipt": receipt,
            "at": time.monotonic() + delay_seconds,
        }

    async def _rpc(self, request: Request, path: str) -> JSONResponse:
        payload = await request.json()
        if isinstance(payload, list):
            return JSONResponse([self._handle(item) for item in payload])
        return JSONResponse(self._handle(payload))

    def _handle(self, payload: dict[str, Any]) -> dict[str, Any]:
        method = payload.get("method")
        params = payload.get("params") or []
        self.requests.append({"method": method, "params": params})
        request_id = payload.get("id")

        def result(value: Any) -> dict[str, Any]:
            return {"jsonrpc": "2.0", "id": request_id, "result": value}

        if method == "eth_getTransactionReceipt":
            entry = self._receipts.get(str(params[0]).lower())
            if entry is None or time.monotonic() < entry["at"]:
                return result(None)
            return result(entry["receipt"])
        if method == "eth_call":
            data = str((params[0] or {}).get("data") or "")
            raw = bytes.fromhex(data[2:]) if data.startswith("0x") else b""
            if raw[:4] == AUDIT_FEE_SELECTOR and self.audit_fee_wei is not None:
                return result("0x" + self.audit_fee_wei.to_bytes(32, "big").hex())
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32000, "message": f"fake-chain: unscripted eth_call {data[:10]}"},
            }
        if method == "eth_chainId":
            return result(hex(84532))
        if method == "net_version":
            return result("84532")
        if method == "eth_blockNumber":
            return result("0x10")
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"fake-chain: method {method!r} not scripted"},
        }


class StripeStub(_SelfServing):
    """Minimal Stripe API: checkout Session create/retrieve for K4 api_base.

    ``create_payment_status`` controls the status newly created sessions carry;
    seed known sessions with ``add_session`` for retrieve/verify flows.
    """

    def __init__(self) -> None:
        super().__init__()
        self.sessions: dict[str, dict[str, Any]] = {}
        # Raw urlencoded create bodies (stripe's bracketed form keys), so tests
        # can assert what was actually charged (line_items[..][unit_amount]).
        self.create_forms: list[dict[str, str]] = []
        self.create_payment_status = "unpaid"
        self.fail_create = False
        self.app = FastAPI()
        self.app.post("/v1/checkout/sessions")(self._create)
        self.app.get("/v1/checkout/sessions/{session_id}")(self._retrieve)

    def clear(self) -> None:
        self.sessions.clear()
        self.create_forms.clear()
        self.create_payment_status = "unpaid"
        self.fail_create = False

    def add_session(
        self,
        session_id: str,
        *,
        package_name: str,
        version: str,
        payment_status: str = "paid",
        email: str | None = None,
    ) -> dict[str, Any]:
        session = self._session_body(
            session_id,
            metadata={"packageName": package_name, "version": version},
            payment_status=payment_status,
            email=email,
        )
        self.sessions[session_id] = session
        return session

    @staticmethod
    def _session_body(
        session_id: str,
        *,
        metadata: dict[str, str],
        payment_status: str,
        email: str | None,
    ) -> dict[str, Any]:
        return {
            "id": session_id,
            "object": "checkout.session",
            "url": f"https://checkout.stripe.example/pay/{session_id}",
            "payment_status": payment_status,
            "status": "complete" if payment_status == "paid" else "open",
            "metadata": metadata,
            "customer_email": email,
        }

    async def _create(self, request: Request) -> JSONResponse:
        if self.fail_create:
            return JSONResponse(
                {"error": {"type": "api_error", "message": "stripe-stub: scripted failure"}},
                status_code=500,
            )
        # urllib-based parse: starlette's request.form() needs python-multipart,
        # which is not an engine dependency; Stripe posts plain urlencoded bodies.
        form = dict(parse_qsl((await request.body()).decode("utf-8")))
        self.create_forms.append(form)
        metadata = {
            match.group(1): value
            for key, value in form.items()
            if (match := _METADATA_FORM_KEY.fullmatch(key))
        }
        email = form.get("customer_email")
        session_id = f"cs_test_{uuid.uuid4().hex[:16]}"
        session = self._session_body(
            session_id,
            metadata=metadata,
            payment_status=self.create_payment_status,
            email=str(email) if email else None,
        )
        self.sessions[session_id] = session
        return JSONResponse(session)

    async def _retrieve(self, session_id: str) -> JSONResponse:
        session = self.sessions.get(session_id)
        if session is None:
            return JSONResponse(
                {
                    "error": {
                        "type": "invalid_request_error",
                        "message": f"No such checkout.session: {session_id}",
                    }
                },
                status_code=404,
            )
        return JSONResponse(session)


# --- GitHub App REST + OAuth stub -------------------------------------------

# expires_at MUST use githubkit's exact strptime format ("%Y-%m-%dT%H:%M:%SZ")
# for AppInstallationAuthStrategy to parse the minted installation token.
_GH_FAR_FUTURE = "2099-01-01T00:00:00Z"
_RAW_REF = "HEAD"


def _bearer_token(request: Request) -> str | None:
    """Extract the trailing token from a ``token <t>`` / ``Bearer <t>`` header."""
    header = request.headers.get("authorization")
    if not header:
        return None
    parts = header.split()
    return parts[-1] if parts else None


def _wrap_base64(content: str) -> str:
    """base64-encode UTF-8 text, wrapped at 60 cols like GitHub's contents API."""
    raw = base64.b64encode(content.encode("utf-8")).decode("ascii")
    return "\n".join(raw[i : i + 60] for i in range(0, len(raw), 60)) + "\n"


def _git_blob_sha(content: str) -> str:
    """Deterministic git blob sha (``sha1("blob <len>\\0" + bytes)``)."""
    data = content.encode("utf-8")
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()  # noqa: S324


class GitHubStub(_SelfServing):
    """Deterministic GitHub REST + OAuth subset behind a REAL socket.

    Point the engine at it with ``NPMGUARD_GITHUB_API_BASE=<base_url>`` — exactly
    as ``NPMGUARD_STRIPE_API_BASE`` redirects Stripe. ``githubkit`` gets that as
    its ``base_url``, and (because the base is not an ``api.github.com`` host)
    the client resolves the OAuth host to the SAME origin, so App-JWT / token /
    OAuth / contents all land here and NO real GitHub is ever hit. The App JWT
    presented as a Bearer is trusted blindly (the harness owns the throwaway
    key).

    Endpoints served:

    - App auth: ``GET /app`` (slug + id); ``POST /app/installations/{id}/
      access_tokens`` (a fake installation token).
    - OAuth: ``GET|POST /login/oauth/access_token`` (code → token payload, or
      ``grant_type=refresh_token`` → rotated payload); ``GET /login/oauth/
      authorize`` (302 back to the callback, accepted if the frontend hits it).
    - User: ``GET /user``, ``GET /user/emails``, ``GET /user/installations``,
      ``GET /user/installations/{id}/repositories``.
    - Repos: ``GET /repos/{owner}/{repo}``, ``GET /repos/{owner}/{repo}/
      contents/{path}`` (base64 file or a directory listing; a non-inline item
      forces the git-blob fallback), ``GET /repos/{owner}/{repo}/git/blobs/
      {sha}``, and ``GET /raw/{owner}/{repo}/{ref}/{path}`` (the public raw
      host).
    - Checks: ``POST|PATCH /repos/{owner}/{repo}/check-runs`` (echo an id;
      bodies recorded on ``.check_runs``).

    Preload the scenario with ``set_app`` / ``set_oauth_code`` / ``set_user`` /
    ``add_installation`` / ``add_repo`` / ``set_lockfile`` etc., then inspect
    ``.requests`` / ``.check_runs``. ``clear()`` resets all state between tests.

    NOTE (public-repo path): ``content.validate_raw_url`` hard-codes
    ``raw.githubusercontent.com`` as the only allowed raw host, so a public-repo
    audit driven through this stub needs that SSRF allow-list made
    configurable (or the raw fetch pointed here) — a coordination point for the
    routes/content stage. The raw route + ``download_url`` are already served so
    that lands cleanly once the allow-list accepts the stub host.
    """

    def __init__(self) -> None:
        super().__init__()
        self._reset_state()
        self.app = FastAPI()
        self.app.get("/app")(self._get_app)
        self.app.post("/app/installations/{installation_id}/access_tokens")(
            self._create_installation_token
        )
        self.app.get("/login/oauth/access_token")(self._oauth_access_token)
        self.app.post("/login/oauth/access_token")(self._oauth_access_token)
        self.app.get("/login/oauth/authorize")(self._oauth_authorize)
        self.app.get("/user")(self._get_user)
        self.app.get("/user/emails")(self._get_user_emails)
        self.app.get("/user/installations")(self._get_user_installations)
        self.app.get("/user/installations/{installation_id}/repositories")(
            self._get_installation_repositories
        )
        self.app.get("/repos/{owner}/{repo}/git/blobs/{sha}")(self._get_blob)
        self.app.post("/repos/{owner}/{repo}/check-runs")(self._create_check_run)
        self.app.patch("/repos/{owner}/{repo}/check-runs/{check_run_id}")(
            self._update_check_run
        )
        self.app.get("/repos/{owner}/{repo}/contents/{path:path}")(self._get_contents)
        self.app.get("/repos/{owner}/{repo}")(self._get_repo)
        self.app.get("/raw/{owner}/{repo}/{ref}/{path:path}")(self._get_raw)

    # --- state ---------------------------------------------------------------

    def _reset_state(self) -> None:
        self.app_meta: dict[str, Any] = {"slug": "npmguard", "id": 1}
        self.installation_token: dict[str, str] = {
            "token": "ghs_stubinstalltoken",
            "expires_at": _GH_FAR_FUTURE,
        }
        # authorization code -> token payload returned by the exchange
        self.oauth_codes: dict[str, dict[str, Any]] = {}
        # refresh token -> rotated token payload returned by a refresh
        self.refresh_results: dict[str, dict[str, Any]] = {}
        # access token -> {"user": {...}, "emails": [...]}
        self.users: dict[str, dict[str, Any]] = {}
        self.installations: list[dict[str, Any]] = []
        self.installation_repos: dict[int, list[dict[str, Any]]] = {}
        self.repos: dict[tuple[str, str], dict[str, Any]] = {}
        # (owner, repo, path) -> file record
        self.files: dict[tuple[str, str, str], dict[str, Any]] = {}
        # (owner, repo, sha) -> base64-wrapped blob content
        self.blobs: dict[tuple[str, str, str], str] = {}
        self.authorize_code = "stub_code"
        self.check_runs: list[dict[str, Any]] = []
        self.requests: list[dict[str, Any]] = []
        self._check_run_seq = 1000

    def clear(self) -> None:
        self._reset_state()

    # --- preload API ---------------------------------------------------------

    def set_app(self, *, slug: str = "npmguard", app_id: int = 1) -> None:
        self.app_meta = {"slug": slug, "id": app_id}

    def set_installation_token(
        self, token: str, *, expires_at: str = _GH_FAR_FUTURE
    ) -> None:
        self.installation_token = {"token": token, "expires_at": expires_at}

    def set_oauth_code(
        self,
        code: str,
        access_token: str,
        *,
        token_type: str = "bearer",
        scope: str = "read:user user:email",
        refresh_token: str | None = None,
        expires_in: int | None = None,
        refresh_token_expires_in: int | None = None,
    ) -> None:
        """Script a ``code`` → token exchange (and optionally the refresh pair)."""
        payload: dict[str, Any] = {
            "access_token": access_token,
            "token_type": token_type,
            "scope": scope,
        }
        if refresh_token is not None:
            payload["refresh_token"] = refresh_token
        if expires_in is not None:
            payload["expires_in"] = expires_in
        if refresh_token_expires_in is not None:
            payload["refresh_token_expires_in"] = refresh_token_expires_in
        self.oauth_codes[code] = payload

    def set_refresh_result(
        self,
        refresh_token: str,
        access_token: str,
        *,
        token_type: str = "bearer",
        scope: str = "read:user user:email",
        new_refresh_token: str | None = None,
        expires_in: int | None = None,
    ) -> None:
        """Script the payload a ``grant_type=refresh_token`` exchange returns."""
        payload: dict[str, Any] = {
            "access_token": access_token,
            "token_type": token_type,
            "scope": scope,
        }
        if new_refresh_token is not None:
            payload["refresh_token"] = new_refresh_token
        if expires_in is not None:
            payload["expires_in"] = expires_in
        self.refresh_results[refresh_token] = payload

    def set_user(
        self,
        access_token: str,
        *,
        id: int,
        login: str,
        name: str | None = None,
        email: str | None = None,
        avatar_url: str | None = None,
        emails: list[dict[str, Any]] | None = None,
    ) -> None:
        """Bind an OAuth access token to the authed-user identity it returns."""
        user = {
            "id": id,
            "login": login,
            "name": name,
            "email": email,
            "avatar_url": avatar_url or f"https://avatars.example/{login}.png",
        }
        if emails is None:
            emails = (
                [{"email": email, "primary": True, "verified": True}] if email else []
            )
        self.users[access_token] = {"user": user, "emails": emails}

    def add_installation(
        self,
        installation_id: int,
        *,
        account_login: str,
        account_type: str = "Organization",
        suspended: bool = False,
    ) -> None:
        self.installations.append(
            {
                "id": installation_id,
                "account": {"login": account_login, "type": account_type},
                "suspended_at": _GH_FAR_FUTURE if suspended else None,
            }
        )
        self.installation_repos.setdefault(installation_id, [])

    def add_repo(
        self,
        owner: str,
        name: str,
        *,
        id: int,
        installation_id: int | None = None,
        private: bool = False,
        default_branch: str = "main",
        html_url: str | None = None,
    ) -> dict[str, Any]:
        repo = {
            "id": id,
            "name": name,
            "full_name": f"{owner}/{name}",
            "owner": {"login": owner, "type": "Organization"},
            "private": private,
            "default_branch": default_branch,
            "html_url": html_url or f"https://github.com/{owner}/{name}",
        }
        self.repos[(owner, name)] = repo
        if installation_id is not None:
            self.installation_repos.setdefault(installation_id, []).append(repo)
        return repo

    def set_repo_file(
        self,
        owner: str,
        repo: str,
        path: str,
        content: str,
        *,
        sha: str | None = None,
        inline: bool = True,
    ) -> str:
        """Register a repo file. ``inline=False`` forces the >1 MB git-blob path.

        Returns the file sha. The content is also reachable via the git-blob
        endpoint and the raw host so every read path resolves.
        """
        file_sha = sha or _git_blob_sha(content)
        self.files[(owner, repo, path)] = {
            "name": path.rsplit("/", 1)[-1],
            "path": path,
            "sha": file_sha,
            "content": content,
            "inline": inline,
        }
        self.blobs[(owner, repo, file_sha)] = _wrap_base64(content)
        return file_sha

    def set_lockfile(
        self,
        owner: str,
        repo: str,
        path: str,
        content: str,
        *,
        sha: str | None = None,
        inline: bool = True,
    ) -> str:
        """Convenience alias for a lockfile at ``path`` (e.g. package-lock.json)."""
        return self.set_repo_file(owner, repo, path, content, sha=sha, inline=inline)

    def set_manifest(self, owner: str, repo: str, content: str) -> str:
        return self.set_repo_file(owner, repo, "package.json", content)

    # --- app auth ------------------------------------------------------------

    async def _get_app(self, request: Request) -> JSONResponse:
        self.requests.append({"method": "GET", "path": "/app"})
        return JSONResponse(self.app_meta)

    async def _create_installation_token(
        self, installation_id: str, request: Request
    ) -> JSONResponse:
        self.requests.append(
            {"method": "POST", "path": f"/app/installations/{installation_id}/access_tokens"}
        )
        return JSONResponse(
            {
                "token": self.installation_token["token"],
                "expires_at": self.installation_token["expires_at"],
                "permissions": {"contents": "read", "checks": "write"},
                "repository_selection": "all",
            }
        )

    # --- oauth ---------------------------------------------------------------

    async def _oauth_params(self, request: Request) -> dict[str, Any]:
        if request.method == "POST":
            body = await request.body()
            if body:
                ctype = request.headers.get("content-type", "")
                if "application/json" in ctype:
                    try:
                        return dict(json.loads(body.decode("utf-8")))
                    except (ValueError, TypeError):
                        return {}
                return dict(parse_qsl(body.decode("utf-8")))
        return dict(request.query_params)

    async def _oauth_access_token(self, request: Request) -> JSONResponse:
        params = await self._oauth_params(request)
        self.requests.append({"method": request.method, "path": "/login/oauth/access_token"})
        if params.get("grant_type") == "refresh_token":
            payload = self.refresh_results.get(str(params.get("refresh_token")))
            if payload is None:
                return JSONResponse(
                    {
                        "error": "bad_refresh_token",
                        "error_description": "The refresh token is invalid.",
                    }
                )
            return JSONResponse(payload)
        payload = self.oauth_codes.get(str(params.get("code")))
        if payload is None:
            return JSONResponse(
                {
                    "error": "bad_verification_code",
                    "error_description": "The code passed is incorrect or expired.",
                }
            )
        return JSONResponse(payload)

    async def _oauth_authorize(self, request: Request) -> RedirectResponse:
        params = request.query_params
        redirect_uri = params.get("redirect_uri", "")
        state = params.get("state", "")
        self.requests.append({"method": "GET", "path": "/login/oauth/authorize"})
        sep = "&" if "?" in redirect_uri else "?"
        return RedirectResponse(
            f"{redirect_uri}{sep}code={self.authorize_code}&state={state}",
            status_code=302,
        )

    # --- user ----------------------------------------------------------------

    def _user_record(self, request: Request) -> dict[str, Any] | None:
        token = _bearer_token(request)
        record = self.users.get(token) if token else None
        if record is None and len(self.users) == 1:
            # Single-user scenarios need not thread the exact token through.
            record = next(iter(self.users.values()))
        return record

    async def _get_user(self, request: Request) -> JSONResponse:
        record = self._user_record(request)
        if record is None:
            return JSONResponse({"message": "Requires authentication"}, status_code=401)
        return JSONResponse(record["user"])

    async def _get_user_emails(self, request: Request) -> JSONResponse:
        record = self._user_record(request)
        if record is None:
            return JSONResponse({"message": "Requires authentication"}, status_code=401)
        return JSONResponse(record["emails"])

    async def _get_user_installations(self, request: Request) -> JSONResponse:
        return JSONResponse(
            {"total_count": len(self.installations), "installations": self.installations}
        )

    async def _get_installation_repositories(
        self, installation_id: str, request: Request
    ) -> JSONResponse:
        repos = self.installation_repos.get(int(installation_id), [])
        return JSONResponse({"total_count": len(repos), "repositories": repos})

    # --- repos + contents ----------------------------------------------------

    async def _get_repo(self, owner: str, repo: str, request: Request) -> JSONResponse:
        found = self.repos.get((owner, repo))
        if found is None:
            return JSONResponse({"message": "Not Found"}, status_code=404)
        return JSONResponse(found)

    def _content_entry(
        self, owner: str, repo: str, rec: dict[str, Any], request: Request, *, listing: bool
    ) -> dict[str, Any]:
        base = str(request.base_url).rstrip("/")
        content = rec["content"]
        entry: dict[str, Any] = {
            "type": "file",
            "name": rec["name"],
            "path": rec["path"],
            "sha": rec["sha"],
            "size": len(content.encode("utf-8")),
            "download_url": f"{base}/raw/{owner}/{repo}/{_RAW_REF}/{rec['path']}",
        }
        if listing:
            return entry
        if rec["inline"]:
            entry["encoding"] = "base64"
            entry["content"] = _wrap_base64(content)
        else:
            # >1 MB: GitHub omits inline content (encoding "none") — blob fallback.
            entry["encoding"] = "none"
            entry["content"] = ""
        return entry

    async def _get_contents(
        self, owner: str, repo: str, path: str, request: Request
    ) -> JSONResponse:
        self.requests.append(
            {"method": "GET", "path": f"/repos/{owner}/{repo}/contents/{path}"}
        )
        key = (owner, repo)
        files_here = {
            p: rec for (o, r, p), rec in self.files.items() if (o, r) == key
        }
        normalized = path.strip("/")
        if normalized == "":
            if not files_here and key not in self.repos:
                return JSONResponse({"message": "Not Found"}, status_code=404)
            listing = [
                self._content_entry(owner, repo, rec, request, listing=True)
                for p, rec in files_here.items()
                if "/" not in p
            ]
            return JSONResponse(listing)
        rec = files_here.get(normalized)
        if rec is None:
            return JSONResponse({"message": "Not Found"}, status_code=404)
        return JSONResponse(self._content_entry(owner, repo, rec, request, listing=False))

    async def _get_blob(
        self, owner: str, repo: str, sha: str, request: Request
    ) -> JSONResponse:
        content = self.blobs.get((owner, repo, sha))
        if content is None:
            return JSONResponse({"message": "Not Found"}, status_code=404)
        return JSONResponse({"sha": sha, "encoding": "base64", "content": content})

    async def _get_raw(
        self, owner: str, repo: str, ref: str, path: str, request: Request
    ) -> Response:
        rec = self.files.get((owner, repo, path.strip("/")))
        if rec is None:
            return JSONResponse({"message": "Not Found"}, status_code=404)
        return Response(rec["content"], media_type="text/plain")

    # --- checks --------------------------------------------------------------

    def _next_check_run_id(self) -> int:
        self._check_run_seq += 1
        return self._check_run_seq

    async def _create_check_run(
        self, owner: str, repo: str, request: Request
    ) -> JSONResponse:
        body = await self._json_body(request)
        check_run_id = self._next_check_run_id()
        self.check_runs.append(
            {"method": "POST", "owner": owner, "repo": repo, "id": check_run_id, "body": body}
        )
        return JSONResponse({"id": check_run_id, **body})

    async def _update_check_run(
        self, owner: str, repo: str, check_run_id: str, request: Request
    ) -> JSONResponse:
        body = await self._json_body(request)
        run_id = int(check_run_id)
        self.check_runs.append(
            {"method": "PATCH", "owner": owner, "repo": repo, "id": run_id, "body": body}
        )
        return JSONResponse({"id": run_id, **body})

    @staticmethod
    async def _json_body(request: Request) -> dict[str, Any]:
        raw = await request.body()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
