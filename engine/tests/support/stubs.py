"""Deterministic HTTP stubs behind REAL sockets: npm registry, chain RPC, Stripe.

Each stub is a FastAPI app served by a background-thread uvicorn on port 0, so
it works both for the out-of-process e2e engine and for in-process unit tests
(e.g. payments tests pointing web3/stripe at ``base_url``). All stub state is
plain per-instance data — ``clear()`` between tests, never share across files.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from typing import Any
from urllib.parse import parse_qsl

import uvicorn
from eth_abi import encode as abi_encode
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
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
