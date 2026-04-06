# NpmGuard — Production Roadmap

> Cross-referenced against: Google OSV-Scanner, Snyk CLI, Socket.dev CLI, Semgrep, Aqua Trivy, Anchore Grype, GitHub CodeQL.
> Generated 2026-04-06. This is the single source of truth for what needs to happen.

---

## Current State

NpmGuard is an AI-powered npm supply chain security auditor with a 6-phase pipeline:
Resolve → Inventory → Triage (LLM) → Investigation (agentic LLM) → Test Generation → Verification (Docker sandbox).

**What works:** The core audit pipeline, streaming frontend, and Docker sandbox are functional.
**What doesn't:** No CI/CD, no persistence, no auth (beyond defunct crypto payment gate), no structured logging, no production deployment story, inconsistent error handling, unbounded in-memory state, and dead crypto code still wired in.

### Architecture After Cleanup

```
engine/          → Hono API server + 6-phase audit pipeline
frontend/        → React + Vite streaming dashboard
sandbox/         → Docker execution harness + test fixtures
docs/            → Architecture, research, guides
```

Everything else (contracts/, chainlink/, npmguard/, cli/) gets deleted.

---

## Phase 0: Scorched Earth Cleanup

**Goal:** Remove dead code, fix security emergencies, establish clean baseline.
**Timeline:** Days 1–3
**Blocks:** Everything else.

### 0.1 Delete crypto subprojects

| Delete       | Reason                                         |
| ------------ | ---------------------------------------------- |
| `contracts/` | Solidity payment contract (0G Galileo testnet) |
| `chainlink/` | Chainlink CRE monitoring (depends on ENS)      |
| `npmguard/`  | ENS/IPFS publisher, demo packages, sginstall   |
| `cli/`       | ENS resolver + WalletConnect payment CLI       |

### 0.2 Sever crypto from engine

| File                    | What to remove                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/src/index.ts`   | `viem` import, `ogGalileo` chain definition (lines 7-18), `AUDIT_REQUEST_ABI` (25-36), `checkPaymentOnChain()` (38-58), contract payment gate in POST `/audit` (142-150), all `publishAuditResults()` calls (86-101, 201-224) |
| `engine/src/publish.ts` | Delete entire file                                                                                                                                                                                                            |
| `engine/package.json`   | Remove `viem`, `pinata`, `@ensdomains/content-hash` deps                                                                                                                                                                      |

### 0.3 Fix the uuid dependency

```diff
- "uuid": "https://gateway.pinata.cloud/ipfs/bafkreia7..."
+ "uuid": "^11.1.0"
```

Pinned to an IPFS gateway URL — will break when Pinata is down.

### 0.5 Lock CORS

```diff
- app.use("/*", cors({ origin: "*" }));
+ app.use("/*", cors({
+   origin: process.env.NPMGUARD_CORS_ORIGIN ?? "http://localhost:5173",
+   credentials: true,
+ }));
```

**Reference:** Every production tool reviewed restricts CORS. None use `*`.

---

## Phase 1: Critical Security & Stability

**Goal:** Safe enough that a real user's request won't crash the server or leak data.
**Timeline:** Week 1
**Blocks:** Phase 2 (can't deploy without this).

### 1.1 Input validation hardening

**Current gap:** Package name validated only as `.min(1)`. No length limit, no character validation.
**What Snyk does:** Validates package names against npm naming rules (max 214 chars, lowercase, no leading dots/underscores).
**What to do:**

```typescript
const PackageName = z
  .string()
  .min(1)
  .max(214)
  .regex(
    /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    "Invalid npm package name",
  );

const AuditRequest = z.object({
  packageName: PackageName,
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
    .optional(),
});
```

**File:** `engine/src/index.ts:65-68`

### 1.2 Rate limiting

**Current gap:** Zero rate limiting. Anyone can fire unlimited audit requests.
**What Snyk does:** Leaky bucket with burst=10, period=500ms, maxRetry=5 (via `snyk-request-manager`).
**What to do:** Add Hono rate limiting middleware.

```typescript
import { rateLimiter } from "hono-rate-limiter";

app.use(
  "/audit/*",
  rateLimiter({
    windowMs: 60_000,
    limit: 10, // 10 audits per minute per IP
    keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "global",
    standardHeaders: "draft-6",
  }),
);
```

**File:** `engine/src/index.ts` — add before route handlers

### 1.3 Bounded audit queue

**Current gap:** `auditQueue` is an unbounded array. Memory grows without limit.
**What Trivy does:** `jobs.LimitChecker` with per-namespace and cluster-wide limits.
**What to do:**

```typescript
const MAX_QUEUE_SIZE = 50;

function enqueueAudit(packageName: string, version?: string): Promise<any> {
  if (auditQueue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new ServiceOverloadedError("Audit queue full"));
  }
  // ... existing code
}
```

Return HTTP 503 with `Retry-After` header.
**File:** `engine/src/index.ts:113-118`

### 1.4 Session memory limits

**Current gap:** `sessions` Map and `eventBuffer` grow unbounded.
**What to do:**

- Max 100 concurrent sessions. Reject new audits with 503 if exceeded.
- Cap `eventBuffer` at 5000 events per session.
- Session TTL: 30 minutes after finalization (already partially exists).
- Add LRU eviction: when at capacity, evict oldest finalized session.

**File:** `engine/src/events.ts`

### 1.5 Typed error hierarchy

**Current gap:** All errors are strings or generic `Error`. Can't distinguish network failures from validation errors.
**What Snyk does:** Error catalog with codes like `SNYK-CLI-0017`, including title, description, HTTP status, and remediation link.
**What to do:** Create `engine/src/errors.ts`:

```typescript
export class NpmGuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "NpmGuardError";
  }
}

export class PackageNotFoundError extends NpmGuardError {
  constructor(packageName: string) {
    super(
      "NPMGUARD-0001",
      `Package "${packageName}" not found on npm registry`,
      404,
    );
  }
}

export class LLMUnavailableError extends NpmGuardError {
  constructor(backend: string, cause?: Error) {
    super(
      "NPMGUARD-0010",
      `LLM backend "${backend}" unavailable: ${cause?.message}`,
      503,
      true,
    );
  }
}

export class DockerUnavailableError extends NpmGuardError {
  constructor() {
    super("NPMGUARD-0020", "Docker daemon not reachable", 503, true);
  }
}

export class AuditTimeoutError extends NpmGuardError {
  constructor(phase: string, timeoutMs: number) {
    super(
      "NPMGUARD-0030",
      `Phase "${phase}" timed out after ${timeoutMs}ms`,
      504,
      true,
    );
  }
}

export class QueueFullError extends NpmGuardError {
  constructor() {
    super("NPMGUARD-0040", "Audit queue is full", 503, true);
  }
}
```

### 1.6 Fix silent error swallowing

**Current gap:** 15+ empty `catch {}` blocks across engine source.
**What OSV-Scanner does:** Consistent `fmt.Errorf("context: %w", err)` error wrapping.
**What to do:** Audit every `catch` block. Replace empty catches with logging:

```typescript
// BEFORE (engine/src/index.ts:94)
} catch { /* use fallback */ }

// AFTER
} catch (err) {
  log.warn({ err, packageName }, "Failed to read package.json for version, using fallback");
}
```

Priority files (by count of silent catches):

1. `engine/src/sandbox/instrumentation.ts` — 6 empty catches
2. `engine/src/index.ts` — 4 empty catches
3. `engine/src/phases/verify.ts` — 3 empty catches
4. `engine/src/phases/test-gen.ts` — 2 empty catches

### 1.7 Graceful shutdown

**Current gap:** `SIGTERM` kills process immediately. In-flight audits lost, SSE clients disconnected without cleanup.
**What Trivy does:** Dual-WaitGroup pattern — `dbUpdateWg` blocks new requests during DB swaps, `requestWg` drains in-flight requests. Uses `http.Server.Shutdown()` with 30-second timeout matching Kubernetes termination grace period.
**What to do:**

```typescript
const server = serve({
  fetch: app.fetch,
  hostname: config.apiHost,
  port: config.apiPort,
});

let shuttingDown = false;

process.on("SIGTERM", () => {
  console.log("[shutdown] SIGTERM received, draining...");
  shuttingDown = true;
  // Stop accepting new audits (existing ones continue)
  server.close(() => {
    console.log("[shutdown] HTTP server closed");
    // Wait for in-flight audits (max 60s)
    const deadline = setTimeout(() => process.exit(1), 60_000);
    waitForAuditsToComplete().then(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  });
});

process.on("unhandledRejection", (err) => {
  console.error("[FATAL] unhandled rejection:", err);
  process.exit(1);
});
```

**File:** `engine/src/index.ts` — bottom of file

---

## Phase 2: Production Infrastructure

**Goal:** The engine can be deployed, monitored, and debugged in production.
**Timeline:** Weeks 2–3
**Blocks:** Phase 3 (can't ship to users without deployment story).

### 2.1 Structured logging

**Current gap:** 129 `console.log/warn/error` calls with ad-hoc `[tag]` prefixes. No timestamps, no request IDs, no log levels, no structured fields.
**What Snyk does:** Bunyan for JSON structured logs. `--debug` and `--log-level` flags. Credential sanitization in debug output.
**What Semgrep does:** Python `logging` with structured formatters. Log level configurable via CLI flag.
**What to do:** Replace all `console.*` with `pino`:

```typescript
// engine/src/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.NPMGUARD_LOG_LEVEL ?? "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: ["*.apiKey", "*.authorization", "*.token", "*.secret", "*.password"],
    censor: "[REDACTED]",
  },
});

// Per-request child logger with request ID
export function createRequestLogger(reqId: string) {
  return logger.child({ reqId });
}
```

Replace every `console.log("[tag] message", data)` with `log.info({ data }, "message")`.

**Effort:** ~2 hours to set up, ~4 hours to migrate all 129 call sites.

### 2.2 Request ID tracing

**Current gap:** No way to correlate log lines across pipeline phases for a single audit.
**What Snyk does:** `urn:snyk:interaction:{uuid}` propagated via `snyk-interaction-id` header across all requests. Enables distributed tracing.
**What to do:** Generate UUID per audit request, thread through all phases:

```typescript
// Middleware
app.use("*", (c, next) => {
  const reqId = c.req.header("x-request-id") ?? randomUUID();
  c.set("reqId", reqId);
  c.header("x-request-id", reqId);
  return next();
});
```

Pass `reqId` into `runAudit()`, all phase functions, and all log calls.

### 2.3 Health checks

**Current gap:** `/health` returns `{status: "ok"}` unconditionally.
**What Trivy does:** Separate `/healthz` (liveness) and `/readyz` (readiness) endpoints. Readiness checks database connectivity.
**What to do:**

```typescript
app.get("/health/live", (c) => c.json({ status: "ok" }));

app.get("/health/ready", async (c) => {
  const checks = {
    docker: await checkDocker(), // exec "docker info" with 5s timeout
    llm: config.llmApiKey ? true : false,
    queue: auditQueue.length < MAX_QUEUE_SIZE,
    sessions: sessions.size < MAX_SESSIONS,
  };
  const healthy = Object.values(checks).every(Boolean);
  return c.json(
    { status: healthy ? "ok" : "degraded", checks },
    healthy ? 200 : 503,
  );
});
```

### 2.4 CI/CD pipeline

**Current gap:** No CI whatsoever. No linting, no type checking, no test runs on PR.
**What OSV-Scanner does:** 18 GitHub Actions workflows, SHA-pinned actions, least-privilege permissions, concurrency controls.
**What to do:** Start with 3 workflows:

**`.github/workflows/ci.yml`** — runs on every PR and push to main:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

permissions: {}

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 22, cache: npm }
      - run: npm ci
        working-directory: engine
      - run: npx tsc --noEmit
        working-directory: engine
      - run: npx eslint src/
        working-directory: engine

  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 22, cache: npm }
      - run: npm ci
        working-directory: engine
      - run: npx vitest run --reporter=verbose --coverage
        working-directory: engine

  frontend-build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 22, cache: npm }
      - run: npm ci
        working-directory: frontend
      - run: npm run build
        working-directory: frontend
```

**`.github/workflows/security.yml`** — weekly + on push:

- `npm audit --audit-level=high`
- CodeQL (if applicable to TS)
- OpenSSF Scorecard

**`.github/workflows/release.yml`** — on tag push:

- Full test suite
- Docker image build + push
- SHA256 checksums

**Key pattern from OSV-Scanner:** Pin all action versions by full SHA, not tags. Set root `permissions: {}` (deny all), grant per-job.

### 2.5 Linting and formatting

**Current gap:** No `.eslintrc`, no `.prettierrc`. Code style inconsistent across files.
**What Socket.dev does:** `oxlint` + `oxfmt` (Rust-based, fast). Lint-staged with Husky pre-commit hooks.
**What to do:**

```bash
# engine/
npm install -D @eslint/js typescript-eslint eslint prettier

# Add to engine/package.json scripts:
"lint": "eslint src/",
"format": "prettier --write src/",
"format:check": "prettier --check src/"
```

Add pre-commit hook via Husky + lint-staged to run on changed files only.

### 2.6 Persistence layer

**Current gap:** All state is in-memory Maps and arrays. Server restart = total data loss.
**What Trivy does:** Three cache backends (filesystem, Redis, memory). Redis required for multi-instance.
**What to do (start simple):**

Phase 1: SQLite via `better-sqlite3` (zero-config, single-file DB):

```typescript
// engine/src/db.ts
import Database from "better-sqlite3";

const db = new Database(process.env.NPMGUARD_DB_PATH ?? "./data/npmguard.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,
    package_name TEXT NOT NULL,
    version TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    verdict TEXT,
    report JSON,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audits_package ON audits(package_name, version);
  CREATE INDEX IF NOT EXISTS idx_audits_status ON audits(status);
`);
```

Phase 2 (later): PostgreSQL for multi-instance deployment.

### 2.7 Dockerfile for engine

**Current gap:** No Dockerfile for the engine (only sandbox has one).
**What Trivy does:** Multi-stage build, non-root user (65534), read-only root filesystem, minimal Alpine base.
**What to do:**

```dockerfile
# Build stage
FROM node:22-slim AS builder
WORKDIR /app
COPY engine/package*.json ./engine/
RUN cd engine && npm ci --production=false
COPY engine/ ./engine/
COPY frontend/ ./frontend/
RUN cd engine && npm run build
RUN cd frontend && npm ci && npm run build

# Runtime stage
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
RUN addgroup --system npmguard && adduser --system --ingroup npmguard npmguard

WORKDIR /app
COPY --from=builder /app/engine/dist ./engine/dist
COPY --from=builder /app/engine/package*.json ./engine/
COPY --from=builder /app/frontend/dist ./frontend/dist
RUN cd engine && npm ci --production

USER npmguard
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8000/health/live || exit 1

CMD ["node", "engine/dist/index.js"]
```

---

## Phase 3: API Design & Auth

**Goal:** The API is something external developers can integrate against.
**Timeline:** Weeks 3–4

### 3.1 Authentication system

**Current gap:** Payment gate removed. No auth at all — anyone with the URL can trigger audits.
**What Snyk does:** Auth hierarchy: CLI flags > `SNYK_TOKEN` env var > `~/.snyk/config` > browser OAuth. Supports personal tokens, service accounts, and org-scoped tokens.
**What to do:**

Start with API key auth (simplest production-ready approach):

```typescript
// Middleware
function requireAuth(c: Context, next: Next) {
  const key =
    c.req.header("authorization")?.replace("Bearer ", "") ??
    c.req.header("x-api-key");

  if (!key) return c.json({ error: "API key required" }, 401);

  const account = validateApiKey(key); // lookup in DB
  if (!account) return c.json({ error: "Invalid API key" }, 403);

  c.set("account", account);
  return next();
}

// Apply to audit endpoints
app.use("/audit/*", requireAuth);
// Health + docs remain public
```

Later: Add Stripe-based billing, usage tracking per API key, tiered rate limits.

### 3.2 Standardized API responses

**Current gap:** Error responses inconsistent — sometimes `{error: "..."}`, sometimes `{error: "...", message: "..."}`, sometimes `{error: "...", details: {...}}`.
**What OSV-Scanner does:** Consistent error envelope with code and message.
**What to do:** Standardize all responses:

```typescript
// Success
{ "data": { ... }, "meta": { "requestId": "...", "duration_ms": 1234 } }

// Error
{ "error": { "code": "NPMGUARD-0001", "message": "...", "retryable": false } }
```

### 3.3 Standardized exit codes (for future CLI)

**What Snyk does:** Exit codes are part of the contract for CI/CD integration.

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Audit passed — no issues found                           |
| 1    | Issues found — package flagged as dangerous              |
| 2    | Execution error (bad input, crash)                       |
| 3    | No packages to audit                                     |
| 69   | External service unavailable (LLM, Docker, npm registry) |
| 75   | Transient failure — retry recommended                    |

Define in `engine/src/constants.ts` for API response codes too.

### 3.4 SARIF output format

**Current gap:** Reports are custom JSON only. Not consumable by GitHub Code Scanning, VS Code, or any standard tool.
**What every production scanner does:** SARIF 2.1.0 is the industry standard.
**What to do:** Add SARIF formatter for audit reports:

```typescript
// engine/src/formatters/sarif.ts
export function toSarif(report: AuditReport, packageName: string): SarifLog {
  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "NpmGuard",
            version: "1.0.0",
            informationUri: "https://npmguard.dev",
            rules: report.proofs.map(proofToRule),
          },
        },
        results: report.proofs.map(proofToResult),
      },
    ],
  };
}
```

**Key limit from GitHub:** 10MB compressed, 25K results/run, fingerprints required for dedup.

### 3.5 Versioned API

```
/v1/audit          POST   — trigger audit
/v1/audit/:id      GET    — get audit result
/v1/audit/:id/sarif GET   — get SARIF report
/v1/health/live    GET    — liveness probe
/v1/health/ready   GET    — readiness probe
```

Prefix all routes with `/v1/` now. When breaking changes needed, add `/v2/` while keeping `/v1/` alive.

---

## Phase 4: Reliability & Observability

**Goal:** When things break in production (they will), you can find out why in minutes, not hours.
**Timeline:** Weeks 4–6

### 4.1 Retry logic for external services

**Current gap:** npm registry, LLM API, Docker — all called once with no retry. If npm registry returns 502, audit fails permanently.
**What Snyk does:** Leaky bucket queue with burst=10, period=500ms, maxRetry=5.
**What to do:**

```typescript
// engine/src/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, label = "operation" } = opts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay =
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      log.warn(
        { err, attempt, maxAttempts, delay, label },
        "Retrying after failure",
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
```

Apply to: npm registry fetch, LLM API calls, Docker exec.

### 4.2 Circuit breaker for Docker

**Current gap:** If Docker daemon is down, every audit attempt hangs for 30s then fails. Queued audits pile up.
**What to do:**

```typescript
// engine/src/circuit-breaker.ts
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private threshold: number = 5,
    private resetTimeMs: number = 60_000,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.resetTimeMs) {
        this.state = "half-open";
      } else {
        throw new DockerUnavailableError();
      }
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = "closed";
      return result;
    } catch (err) {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= this.threshold) this.state = "open";
      throw err;
    }
  }
}
```

### 4.3 Metrics endpoint

**Current gap:** Zero observability. No way to know how many audits are running, failing, or queued.
**What Trivy does:** Prometheus metrics via `/metrics` endpoint.
**What to do:** Expose key metrics:

```
npmguard_audits_total{verdict="SAFE|DANGEROUS|ERROR"} counter
npmguard_audits_in_progress gauge
npmguard_audit_duration_seconds{phase="resolve|triage|investigate|test-gen|verify"} histogram
npmguard_queue_depth gauge
npmguard_sessions_active gauge
npmguard_llm_requests_total{model,status} counter
npmguard_docker_executions_total{status} counter
```

Use `prom-client` library. Expose at `/metrics` (Prometheus-compatible).

### 4.4 Package integrity verification

**Current gap:** Tarball downloaded from npm registry with no checksum verification. MITM possible.
**What OSV-Scanner does:** Verifies package integrity from registry metadata.
**What to do:**

```typescript
// In resolve.ts
const metadata = await fetch(`${NPM_REGISTRY}/${packageName}`).then((r) =>
  r.json(),
);
const tarball = metadata.versions[version].dist;
const response = await fetch(tarball.tarball);
const buffer = await response.arrayBuffer();

// Verify integrity
const hash = crypto
  .createHash("sha512")
  .update(Buffer.from(buffer))
  .digest("base64");
const expected = tarball.integrity; // "sha512-..."
if (`sha512-${hash}` !== expected) {
  throw new IntegrityError(packageName, version);
}
```

### 4.5 Startup validation

**Current gap:** Config loads and validates env vars, but doesn't verify that Docker is running, LLM key works, or disk has space.
**What to do:**

```typescript
async function validateRuntime() {
  // Check Docker
  try {
    execFileSync("docker", ["info"], { timeout: 5000, stdio: "pipe" });
  } catch {
    logger.error(
      "Docker daemon not reachable — sandbox verification will fail",
    );
    if (process.env.NODE_ENV === "production") process.exit(1);
  }

  // Check LLM connectivity (lightweight)
  if (config.llmApiKey) {
    try {
      await testLLMConnection(config.llmBackend, config.llmApiKey);
    } catch (err) {
      logger.error({ err }, "LLM API key validation failed");
      if (process.env.NODE_ENV === "production") process.exit(1);
    }
  }

  // Check disk space (need temp space for package extraction)
  const { available } = await checkDiskSpace("/tmp");
  if (available < 500 * 1024 * 1024) {
    // 500MB
    logger.warn({ available }, "Low disk space on /tmp");
  }
}
```

### 4.6 Crash reporting

**What Socket.dev does:** Sentry integration wrapping CLI dispatch. Separate `instrument-with-sentry.mts` for initialization.
**What to do:** Add Sentry (or similar) to the engine:

```typescript
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.NPMGUARD_SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "development",
  tracesSampleRate: 0.1,
  beforeSend(event) {
    // Strip sensitive data
    if (event.request?.headers) {
      delete event.request.headers["authorization"];
      delete event.request.headers["x-api-key"];
    }
    return event;
  },
});
```

---

## Phase 5: Testing & Quality

**Goal:** Confidence that changes don't break things. Coverage high enough to catch regressions.
**Timeline:** Weeks 4–8 (parallel with Phase 4)

### 5.1 Test categorization

**Current gap:** 10 unit test files, no categorization, no coverage enforcement.
**What Semgrep does:** `@pytest.mark.quick` (<100ms), `@pytest.mark.kinda_slow` (<2s), `@pytest.mark.slow` (>2s). Enforced — unmarked tests fail CI.
**What to do:**

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 60, // Start here, increase to 80 over time
        branches: 50,
      },
    },
    testTimeout: 10_000, // 10s default
  },
});
```

Organize tests:

```
tests/
  unit/           # No external deps, <100ms each
  integration/    # Needs Docker or mocked LLM, <30s each
  e2e/            # Full pipeline, <5min each
```

### 5.2 VCR/cassette testing for LLM calls

**Current gap:** Can't test triage/investigation/test-gen without hitting live LLM API. Tests are expensive and non-deterministic.
**What OSV-Scanner does:** `go-vcr` library records/replays HTTP interactions. Daily CI re-records cassettes, creates auto-PRs when responses change.
**What to do:** Use `msw` (already in devDependencies) to record/replay LLM API responses:

```typescript
// tests/fixtures/cassettes/triage-env-exfil.json
// Record actual LLM response once, replay in tests
const handlers = [
  http.post("https://api.anthropic.com/v1/messages", () => {
    return HttpResponse.json(loadCassette("triage-env-exfil"));
  }),
];
```

### 5.3 Integration test for full pipeline

**Current gap:** No test covers the full Resolve → ... → Verify pipeline.
**What to do:** Test with a known-bad package (test-pkg-env-exfil) against mocked LLM:

```typescript
// tests/integration/pipeline.test.ts
describe("full audit pipeline", () => {
  it("detects env exfiltration in test-pkg-env-exfil", async () => {
    const { report } = await runAudit("test-pkg-env-exfil");
    expect(report.verdict).toBe("DANGEROUS");
    expect(report.proofs.length).toBeGreaterThan(0);
    expect(report.proofs[0].kind).toBe("TEST_CONFIRMED");
  }, 120_000); // 2 min timeout
});
```

### 5.4 Frontend tests

**Current gap:** Zero frontend tests.
**What to do:** Start with component tests using Vitest + React Testing Library:

```typescript
// frontend/tests/VerdictBanner.test.tsx
import { render, screen } from "@testing-library/react";
import { VerdictBanner } from "../src/components/VerdictBanner";

test("renders DANGEROUS verdict in red", () => {
  render(<VerdictBanner verdict="DANGEROUS" proofCount={3} capabilities={["network"]} />);
  expect(screen.getByText("DANGEROUS")).toHaveClass("text-red");
});
```

### 5.5 Type coverage

**What Socket.dev does:** 95% type coverage enforced via `type-coverage` with strict mode.
**What to do:**

```bash
npm install -D type-coverage
npx type-coverage --at-least 90 --strict --ignore-files "tests/**"
```

Add to CI.

---

## Phase 6: Distribution & Developer Experience

**Goal:** Real developers can install and use NpmGuard easily.
**Timeline:** Weeks 6–10

### 6.1 CLI rebuild (post-crypto)

The old CLI was crypto-dependent. Build a new, simple CLI:

```bash
npx npmguard scan express        # Audit a package
npx npmguard scan --path .       # Audit all deps in package.json
npx npmguard scan --json         # JSON output
npx npmguard scan --sarif        # SARIF output for GitHub integration
```

No ENS, no WalletConnect, no on-chain anything. Just HTTP calls to the engine API.

### 6.2 GitHub Action

```yaml
# .github/actions/npmguard/action.yml
name: NpmGuard Security Scan
inputs:
  api-key:
    required: true
  packages:
    description: "Comma-separated packages to audit, or 'all' for package.json"
    default: "all"
runs:
  using: node22
  main: dist/index.js
```

Uploads SARIF to GitHub Code Scanning. This is how most teams will use NpmGuard.

### 6.3 Documentation site

**What OSV-Scanner does:** Jekyll-based docs site with link validation CI.
**What to do:**

- Landing page explaining what NpmGuard does
- API reference (auto-generated from OpenAPI spec)
- Getting started guide
- Self-hosting guide
- GitHub Action setup guide
- How the audit pipeline works (with diagrams)

### 6.4 Docker Compose for self-hosting

```yaml
services:
  engine:
    build: .
    ports: ["8000:8000"]
    environment:
      NPMGUARD_LLM_API_KEY: ${LLM_API_KEY}
      NPMGUARD_DB_PATH: /data/npmguard.db
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped
    healthcheck:
      test: wget -qO- http://localhost:8000/health/live || exit 1
      interval: 30s
```

### 6.5 npm provenance on publish

**What Socket.dev does:** Dedicated workflow for npm provenance/SLSA attestation.
**What to do:** When publishing CLI to npm:

```bash
npm publish --provenance
```

This generates SLSA Build L3 attestation, proving the package was built from this repo's CI.

---

## Phase 7: Scale

**Goal:** Handle real traffic without falling over.
**Timeline:** Months 2–3

### 7.1 PostgreSQL migration

Replace SQLite with PostgreSQL when traffic exceeds what a single instance handles.

### 7.2 Redis-backed queue

Replace in-memory audit queue with BullMQ (Redis-backed):

- Persistent across restarts
- Multiple worker instances
- Dead letter queue for failed audits
- Priority queues (paid audits first)

### 7.3 Multi-instance deployment

- Kubernetes deployment with horizontal pod autoscaling
- Separate audit workers from API servers
- Shared PostgreSQL + Redis

### 7.4 Result caching

Cache audit results by package@version. If already audited, return cached result.
TTL: 7 days for SAFE, 30 days for DANGEROUS (re-audit on demand).

### 7.5 Telemetry

**What Semgrep does:** Three modes: auto/on/off. `auto` = only when using cloud features. Pseudoanonymize identifiers via SHA-256. Document exactly what is collected. Never collect source code.
**What to do:** Opt-in telemetry for usage analytics:

```typescript
type MetricsMode = "auto" | "on" | "off";
// Env: NPMGUARD_METRICS=off
// Default: auto (send only when using hosted API)

// What to collect: command, duration, verdict, package count, error class
// Never collect: package contents, API keys, file contents
```

---

## Priority Matrix

| Phase | Items                                             | Urgency        | Effort     | Ship Blocker?                    |
| ----- | ------------------------------------------------- | -------------- | ---------- | -------------------------------- |
| **0** | Crypto removal, secret rotation, CORS             | **NOW**        | 1 day      | Yes                              |
| **1** | Input validation, rate limiting, errors, shutdown | **Week 1**     | 3–4 days   | Yes                              |
| **2** | Logging, CI/CD, persistence, Dockerfile           | **Weeks 2–3**  | 8–10 days  | Yes                              |
| **3** | Auth, API design, SARIF, versioning               | **Weeks 3–4**  | 5–7 days   | Yes                              |
| **4** | Retries, circuit breakers, metrics, Sentry        | **Weeks 4–6**  | 5–7 days   | No (but critical for ops)        |
| **5** | Test coverage, VCR, integration tests             | **Weeks 4–8**  | 8–10 days  | No (but critical for confidence) |
| **6** | CLI, GitHub Action, docs site, Docker Compose     | **Weeks 6–10** | 10–15 days | Partially (need CLI + docs)      |
| **7** | PostgreSQL, Redis queue, multi-instance, caching  | **Months 2–3** | 15–20 days | No (scale when needed)           |

**Minimum viable ship (Phases 0–3):** ~4 weeks of focused work.
**Production-grade (Phases 0–6):** ~10 weeks.
**Enterprise-ready (all phases):** ~16 weeks.

---

## Quick Reference: What Production Tools Do That We Don't

| Capability         |   OSV-Scanner   |      Snyk       |      Socket       |    Semgrep     |       Trivy        |   **NpmGuard**   |
| ------------------ | :-------------: | :-------------: | :---------------: | :------------: | :----------------: | :--------------: |
| CI/CD pipeline     |  18 workflows   |    CircleCI     |    3 workflows    |  GHA + Circle  |        GHA         |     **None**     |
| Structured logging |    slog (Go)    |     Bunyan      |      Console      | Python logging |        logr        | **console.log**  |
| Error codes        | Sentinel errors |  Error catalog  |   Typed errors    |  Named errors  |   Wrapped errors   |   **Strings**    |
| Auth               |    N/A (CLI)    |  Token + OAuth  |     API token     | Token + OAuth  |     N/A (CLI)      |     **None**     |
| Rate limiting      |   None (CLI)    |  Leaky bucket   |    None (CLI)     |   None (CLI)   |   None (scanner)   |     **None**     |
| Retry/backoff      |      None       | 5x with backoff |       None        |      None      |        None        |     **None**     |
| Test coverage      |   High + VCR    |  High + mocks   | Type coverage 95% |  Categorized   |        High        | **Partial unit** |
| SARIF output       |       Yes       |       Yes       |        Yes        |      Yes       |        Yes         |      **No**      |
| Provenance/SLSA    |      SLSA3      |       N/A       |  npm provenance   |      N/A       |       Cosign       |      **No**      |
| Graceful shutdown  |       N/A       |       N/A       |        N/A        |      N/A       |   Dual WaitGroup   |     **None**     |
| Health checks      |       N/A       |       N/A       |        N/A        |      N/A       | /healthz + /readyz |     **Stub**     |
| Persistence        |       N/A       |      Cloud      |       Cloud       |     Cloud      |    SQLite/Redis    |  **In-memory**   |
| Config validation  |    Go types     |  Viper + flags  | JSONSchema + Ajv  |  YAML schema   |  Viper + Flag[T]   |  **Zod (good)**  |
| Request tracing    |       N/A       | Interaction ID  |        N/A        |      N/A       |        N/A         |     **None**     |
| Crash reporting    |       N/A       |       N/A       |      Sentry       |      N/A       |        N/A         |     **None**     |

**Our one advantage:** Zod config validation is already on par with the best. The audit pipeline itself is novel and more sophisticated than any of these tools' scanning approaches. We just need the production wrapper.
