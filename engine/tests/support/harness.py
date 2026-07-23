"""Out-of-process e2e harness: real uvicorn on an ephemeral port, throwaway DB.

The engine subprocess receives a FULLY EXPLICIT environment (every NPMGUARD_*
knob set; inherited NPMGUARD_* stripped) so no .env or ambient config can leak
into a scenario. Reports and audit logs land in per-harness tmp dirs via
NPMGUARD_DATA_DIR / NPMGUARD_AUDIT_LOG_DIR; external endpoints default to a
dead loopback address so nothing escapes the test unless a stub is wired in.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import socket
import subprocess
import time
import uuid
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import IO, Any

import httpx
from sqlalchemy.engine import make_url

ENGINE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = ENGINE_ROOT.parent

READY_TIMEOUT_SECONDS = 20.0
READY_POLL_INTERVAL_SECONDS = 0.15
CLOSE_GRACE_SECONDS = 5.0
PG_READY_TIMEOUT_SECONDS = 60.0
DOCKER_PROBE_TIMEOUT_SECONDS = 20.0
HTTP_PROBE_TIMEOUT_SECONDS = 5.0
STDERR_TAIL_LINES = 60

SANDBOX_IMAGE = "npmguard-sandbox:v1"
POSTGRES_IMAGE = "postgres:17-alpine"

# Loopback address that refuses connections immediately — the hermetic default
# for registry/LLM/chain endpoints when no stub is attached.
DEAD_URL = "http://127.0.0.1:1"


def alloc_port() -> int:
    """Bind-port-0 probe. Small race window; acceptable on loopback."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def sqlite_url(path: Path | str) -> str:
    return f"sqlite+aiosqlite:///{path}"


@lru_cache(maxsize=1)
def docker_available() -> tuple[bool, str]:
    """(ok, reason-if-not). NPMGUARD_TEST_DOCKER=0 forces off."""
    if os.environ.get("NPMGUARD_TEST_DOCKER") == "0":
        return False, "NPMGUARD_TEST_DOCKER=0 forces docker off"
    if shutil.which("docker") is None:
        return False, "docker binary not on PATH"
    try:
        probe = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            text=True,
            timeout=DOCKER_PROBE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return False, "docker info timed out"
    if probe.returncode != 0:
        return False, f"docker info failed: {probe.stderr.strip()[:200]}"
    return True, ""


@lru_cache(maxsize=1)
def sandbox_image_available() -> tuple[bool, str]:
    ok, reason = docker_available()
    if not ok:
        return False, reason
    probe = subprocess.run(
        ["docker", "image", "inspect", SANDBOX_IMAGE],
        capture_output=True,
        text=True,
        timeout=DOCKER_PROBE_TIMEOUT_SECONDS,
    )
    if probe.returncode != 0:
        return False, f"sandbox image {SANDBOX_IMAGE} not present"
    return True, ""


def postgres_available() -> tuple[bool, str]:
    if os.environ.get("NPMGUARD_TEST_PG_DSN"):
        return True, ""
    ok, reason = docker_available()
    if ok:
        return True, ""
    return False, f"postgres: NPMGUARD_TEST_PG_DSN unset and no docker ({reason})"


def cli_dist_available() -> tuple[bool, str]:
    path = REPO_ROOT / "cli" / "dist"
    if path.is_dir():
        return True, ""
    return False, f"cli gate: {path} does not exist (build the CLI first)"


@dataclass(frozen=True)
class EngineSpec:
    """One DB engine axis entry; skip_reason is None when runnable here."""

    name: str
    skip_reason: str | None


def engines() -> list[EngineSpec]:
    ok, reason = postgres_available()
    return [
        EngineSpec("sqlite", None),
        EngineSpec("postgres", None if ok else reason),
    ]


class PostgresProvisioner:
    """Throwaway Postgres: NPMGUARD_TEST_PG_DSN override, else a docker container.

    ``fresh_database()`` creates an isolated database per call and returns the
    asyncpg URL for NPMGUARD_DATABASE_URL.
    """

    def __init__(self, server_url: Any, container: str | None) -> None:
        self._server_url = server_url
        self._container = container

    @classmethod
    def start(cls) -> PostgresProvisioner:
        dsn = os.environ.get("NPMGUARD_TEST_PG_DSN")
        if dsn:
            return cls(make_url(dsn), None)
        ok, reason = docker_available()
        if not ok:
            raise RuntimeError(f"cannot provision postgres: {reason}")
        port = alloc_port()
        name = f"npmguard-test-pg-{uuid.uuid4().hex[:8]}"
        subprocess.run(
            [
                "docker", "run", "-d", "--rm", "--name", name,
                "-e", "POSTGRES_USER=npmguard",
                "-e", "POSTGRES_PASSWORD=npmguard",
                "-e", "POSTGRES_DB=postgres",
                "-p", f"127.0.0.1:{port}:5432",
                POSTGRES_IMAGE,
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
        provisioner = cls(
            make_url(f"postgresql://npmguard:npmguard@127.0.0.1:{port}/postgres"), name
        )
        try:
            provisioner._wait_ready()
        except BaseException:
            provisioner.stop()
            raise
        return provisioner

    def _wait_ready(self) -> None:
        deadline = time.monotonic() + PG_READY_TIMEOUT_SECONDS
        assert self._container is not None
        while time.monotonic() < deadline:
            probe = subprocess.run(
                ["docker", "exec", self._container, "pg_isready", "-U", "npmguard"],
                capture_output=True,
                timeout=10,
            )
            if probe.returncode == 0 and self._host_port_ready():
                return
            time.sleep(0.5)
        raise RuntimeError(
            f"postgres container {self._container} not ready within {PG_READY_TIMEOUT_SECONDS}s"
        )

    def _host_port_ready(self) -> bool:
        import psycopg2

        try:
            conn = psycopg2.connect(self.sync_dsn(), connect_timeout=3)
        except Exception:
            return False
        conn.close()
        return True

    def sync_dsn(self) -> str:
        return self._server_url.set(drivername="postgresql").render_as_string(
            hide_password=False
        )

    def fresh_database(self, prefix: str = "npmguard_test") -> str:
        import psycopg2

        name = f"{prefix}_{uuid.uuid4().hex[:12]}"
        conn = psycopg2.connect(self.sync_dsn())
        try:
            conn.autocommit = True
            with conn.cursor() as cursor:
                cursor.execute(f'CREATE DATABASE "{name}"')
        finally:
            conn.close()
        return self._server_url.set(
            drivername="postgresql+asyncpg", database=name
        ).render_as_string(hide_password=False)

    def stop(self) -> None:
        if self._container is not None:
            subprocess.run(
                ["docker", "rm", "-f", self._container],
                capture_output=True,
                timeout=60,
            )
            self._container = None


class EngineHarness:
    """One real engine process. start() → use base_url → close().

    Every constructor argument maps to an env knob; ``env`` wins last for
    scenario-specific overrides (e.g. {"NPMGUARD_ENV": "prod"}).
    """

    def __init__(
        self,
        *,
        workdir: Path,
        db_url: str | None = None,
        llm_url: str | None = None,
        registry_url: str | None = None,
        stripe_api_base: str | None = None,
        stripe_secret_key: str | None = None,
        stripe_webhook_secret: str | None = None,
        chain_rpc_url: str | None = None,
        chain_contract: str | None = None,
        cre_api_key: str | None = None,
        payment_required: bool = False,
        triage_model: str = "mock-triage",
        investigation_model: str = "mock-investigation",
        llm_timeout_seconds: float = 15,
        triage_concurrency: int = 8,
        queue_size: int | None = None,
        max_running_sessions: int | None = None,
        env: dict[str, str] | None = None,
        port: int | None = None,
    ) -> None:
        self.workdir = Path(workdir)
        self.port = port or alloc_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.data_dir = self.workdir / "data"
        self.audit_log_dir = self.workdir / "audit-logs"
        self.db_url = db_url or sqlite_url(self.workdir / "db.sqlite3")
        self.llm_url = llm_url
        self.registry_url = registry_url
        self.stripe_api_base = stripe_api_base
        self.stripe_secret_key = stripe_secret_key
        self.stripe_webhook_secret = stripe_webhook_secret
        self.chain_rpc_url = chain_rpc_url
        self.chain_contract = chain_contract
        self.cre_api_key = cre_api_key
        self.payment_required = payment_required
        self.triage_model = triage_model
        self.investigation_model = investigation_model
        self.llm_timeout_seconds = llm_timeout_seconds
        self.triage_concurrency = triage_concurrency
        self.queue_size = queue_size
        self.max_running_sessions = max_running_sessions
        self.extra_env = dict(env or {})
        self.proc: subprocess.Popen[bytes] | None = None
        self._env: dict[str, str] | None = None
        self._stderr_path = self.workdir / "engine.stderr.log"
        self._stderr_file: IO[bytes] | None = None

    def build_env(self) -> dict[str, str]:
        base = {key: value for key, value in os.environ.items() if not key.startswith("NPMGUARD_")}
        base.update(
            {
                "PYTHONUNBUFFERED": "1",
                "NPMGUARD_ENV": "dev",
                "NPMGUARD_LOG_LEVEL": "info",
                "NPMGUARD_DATABASE_URL": self.db_url,
                "NPMGUARD_DATA_DIR": str(self.data_dir),
                "NPMGUARD_AUDIT_LOG_DIR": str(self.audit_log_dir),
                "NPMGUARD_NPM_REGISTRY": self.registry_url or DEAD_URL,
                "NPMGUARD_LLM_BACKEND": "openai_compatible",
                "NPMGUARD_LLM_BASE_URL": self.llm_url or f"{DEAD_URL}/v1",
                "NPMGUARD_LLM_API_KEY": "test",
                "NPMGUARD_LLM_TIMEOUT_SECONDS": str(self.llm_timeout_seconds),
                "NPMGUARD_LLM_BUDGET_USD_24H": "0",
                "NPMGUARD_TRIAGE_MODEL": self.triage_model,
                "NPMGUARD_INVESTIGATION_MODEL": self.investigation_model,
                "NPMGUARD_MOCK_LLM": "false",
                "NPMGUARD_PAYMENT_REQUIRED": "true" if self.payment_required else "false",
                "NPMGUARD_TRIAGE_CONCURRENCY": str(self.triage_concurrency),
                "NPMGUARD_STRIPE_SECRET_KEY": self.stripe_secret_key or "",
                "NPMGUARD_STRIPE_WEBHOOK_SECRET": self.stripe_webhook_secret or "",
                "NPMGUARD_STRIPE_API_BASE": self.stripe_api_base or "",
                "NPMGUARD_CRE_API_KEY": self.cre_api_key or "",
                "NPMGUARD_BASE_SEPOLIA_RPC_URL": self.chain_rpc_url or "",
                "NPMGUARD_BASE_SEPOLIA_CONTRACT": self.chain_contract or "",
                "NPMGUARD_BASE_RPC_URL": "",
                "NPMGUARD_BASE_CONTRACT": "",
            }
        )
        if self.queue_size is not None:
            base["NPMGUARD_QUEUE_SIZE"] = str(self.queue_size)
        if self.max_running_sessions is not None:
            base["NPMGUARD_MAX_RUNNING_SESSIONS"] = str(self.max_running_sessions)
        base.update(self.extra_env)
        return base

    def start(self, *, wait_ready: bool = True) -> EngineHarness:
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.audit_log_dir.mkdir(parents=True, exist_ok=True)
        self._env = self.build_env()
        self._spawn()
        if wait_ready:
            self.wait_ready()
        return self

    def _spawn(self) -> None:
        uv = shutil.which("uv") or "uv"
        command = [
            uv, "run", "--frozen", "--project", str(ENGINE_ROOT),
            "uvicorn", "npmguard.api:app",
            "--host", "127.0.0.1",
            "--port", str(self.port),
            "--timeout-graceful-shutdown", "2",
        ]
        assert self._env is not None
        # Lives across the subprocess' lifetime; closed in close()/restart().
        self._stderr_file = open(self._stderr_path, "ab")  # noqa: SIM115
        self.proc = subprocess.Popen(
            command,
            cwd=self.workdir,
            env=self._env,
            stdout=self._stderr_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    def wait_ready(self, timeout: float = READY_TIMEOUT_SECONDS) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(
                    f"engine exited (code {self.proc.returncode}) before /health; "
                    f"stderr tail:\n{self.stderr_tail()}"
                )
            try:
                response = httpx.get(
                    f"{self.base_url}/health", timeout=HTTP_PROBE_TIMEOUT_SECONDS
                )
                if response.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(READY_POLL_INTERVAL_SECONDS)
        raise RuntimeError(
            f"engine not ready on {self.base_url} within {timeout}s; "
            f"stderr tail:\n{self.stderr_tail()}"
        )

    def wait_exit(self, timeout: float = 20.0) -> int | None:
        """Wait for the process to exit on its own (e.g. boot-invariant refusal)."""
        if self.proc is None:
            return None
        with contextlib.suppress(subprocess.TimeoutExpired):
            self.proc.wait(timeout=timeout)
        return self.proc.poll()

    def stderr_tail(self, lines: int = STDERR_TAIL_LINES) -> str:
        try:
            text = self._stderr_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return "(no stderr captured)"
        return "\n".join(text.splitlines()[-lines:])

    @property
    def is_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def restart(self, *, wait_ready: bool = True) -> None:
        """SIGKILL the group and respawn on the SAME port with the SAME db/env."""
        if self.proc is not None:
            self._signal_group(signal.SIGKILL)
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.proc.wait(timeout=10)
        if self._stderr_file is not None:
            self._stderr_file.close()
        self._spawn()
        if wait_ready:
            self.wait_ready()

    def close(self, grace: float = CLOSE_GRACE_SECONDS) -> bool:
        """SIGTERM + grace → True if it exited gracefully; SIGKILL fallback → False."""
        if self.proc is None:
            return True
        proc, self.proc = self.proc, None
        graceful = True
        if proc.poll() is None:
            self._signal_group(signal.SIGTERM, proc=proc)
            try:
                proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                graceful = False
        self._signal_group(signal.SIGKILL, proc=proc)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=10)
        if self._stderr_file is not None:
            self._stderr_file.close()
            self._stderr_file = None
        return graceful

    def _signal_group(self, sig: int, proc: subprocess.Popen[bytes] | None = None) -> None:
        target = proc if proc is not None else self.proc
        if target is None:
            return
        # start_new_session=True makes the child a group leader (pgid == pid),
        # so this reaches the uv parent AND the venv uvicorn child.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(target.pid, sig)

    def start_audit(self, package_name: str, version: str | None = None, **extra: Any) -> dict:
        """POST /audit/stream (dev free path unless extra carries payment proof)."""
        payload: dict[str, Any] = {"packageName": package_name, **extra}
        if version is not None:
            payload["version"] = version
        response = httpx.post(f"{self.base_url}/audit/stream", json=payload, timeout=30)
        response.raise_for_status()
        return response.json()

    def __enter__(self) -> EngineHarness:
        if self.proc is None:
            self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
