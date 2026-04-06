# Production Security Scanner Architecture Research

Research into Trivy, Grype, and GitHub CodeQL/Advanced Security patterns for informing NpmGuard Auditor's production architecture.

---

## 1. Scanning Pipeline Architecture

### Trivy: Three-Phase Pipeline

Trivy implements a consistent three-phase workflow regardless of target type:

1. **Scan Phase** -- `artifact.Run()` dispatches to target-specific methods (`ScanImage()`, `ScanFilesystem()`, etc.) based on a `TargetKind` enum. The `scan.Service` interface abstracts between local scanning and RPC-based remote execution.
2. **Filter Phase** -- `runner.Filter()` applies security policies via `result.Filter()`, incorporating severity filtering, ignore policies, and VEX statements.
3. **Report Phase** -- `report.Write()` dispatches to format-specific writers (JSON, SARIF, CycloneDX, SPDX, Table, or custom Go templates).

Key packages:

- `pkg/commands/` -- CLI orchestration via Cobra
- `pkg/fanal/` -- Artifact analysis (layer processing, package extraction)
- `pkg/fanal/analyzer/` -- `AnalyzerGroup` chains multiple analyzers per ecosystem
- `pkg/detector/` -- Vulnerability detection with version comparers per ecosystem (20+)
- `pkg/scan/` -- Service implementations (local and client modes)
- `pkg/rpc/` -- Twirp RPC protocol for client/server
- `pkg/report/` -- Format-specific writers
- `pkg/flag/` -- Configuration system with Viper
- `pkg/db/` -- Database management

Four independent scanner types can be enabled/disabled via `--scanners`:

- `vuln` -- CVE detection in OS packages and app dependencies
- `misconfig` -- IaC security issues
- `secret` -- Hardcoded credentials/keys
- `license` -- License compliance

### Grype: Matcher-Based Pipeline

Grype uses a sequential pipeline in `grype/lib.go`:

1. **Input Processing** -- Accept image/directory/SBOM via `Provide()`
2. **Package Discovery** -- Syft generates `syft.pkg.Collection`; Grype converts via `pkg.FromCollection()`
3. **Package Synthesis** -- `New()` extracts metadata, creates upstream packages, applies enhancers
4. **Overlap Resolution** -- `removePackagesByOverlap()` deduplicates using relationship analysis
5. **Matcher Iteration** -- For each package, call matchers in priority order
6. **Vulnerability Query** -- Matchers call provider's `GetVulnerabilities()`
7. **Version Matching** -- Compare package version against vulnerability constraints
8. **Result Aggregation** -- Combine matches, apply VEX filters, ignore rules
9. **Output Generation** -- Format via selected presenter

Key packages:

- `grype/pkg/` -- Package discovery and synthesis
- `grype/db/v6/` -- SQLite-backed vulnerability database
- `grype/matcher/` -- Ecosystem-specific matchers (APK, RPM, DPKG, Java, Python, JS, Go, Ruby, Rust, etc.)
- `grype/match/` -- Match result types and Matcher interface
- `grype/search/` -- Query execution (ecosystem, distro, CPE strategies)
- `grype/presenter/` -- Output format handlers

The **Matcher interface**: `Match(vulnerability.Provider, *pkg.Package, *pkg.Collection) ([]match.Match, error)`

Matcher hierarchy:

1. **Ecosystem Matchers** -- Specialized (ApkMatcher, JavaMatcher, etc.)
2. **Stock Matcher** -- CPE-based fallback
3. **Language-Specific** -- Python, JS, Ruby with version constraint logic

Three search dimensions:

- **Ecosystem Search** -- Direct package name + ecosystem context
- **Distribution Search** -- OS-specific vulnerability feeds (Alpine SecDB, RHEL advisories, Debian DSA)
- **CPE Search** -- Broad CPE-based matching as fallback

### CodeQL: Database-Query Pipeline

CodeQL uses a fundamentally different approach -- semantic code analysis:

1. **Extraction** -- Process source code to create a CodeQL relational database
2. **Query Selection** -- Determine security queries based on configuration and query suite
3. **Query Execution** -- Run QL queries against the database
4. **Result Interpretation** -- Process query results into human-readable findings
5. **SARIF Generation** -- Create standardized output
6. **Result Upload** -- Push to GitHub Code Scanning API

Build modes: `none` (interpreted languages), `autobuild` (auto-detected build), `manual` (user-specified build command).

**Actionable pattern**: All three tools use a clean phase separation. Scanning/analysis is decoupled from detection/matching, which is decoupled from output formatting. Each phase communicates through well-defined internal data models.

---

## 2. Database / Storage Patterns

### Trivy: BoltDB + OCI Distribution

- **Vulnerability DB**: BoltDB file (`~/.cache/trivy/db/trivy.db`), schema version 2
- **Java Index**: SQLite (`~/.cache/trivy/java-db/`)
- **Policy Bundles**: WASM modules (`~/.cache/trivy/policy/`)
- **Layer Cache**: Intermediate analysis results in `~/.cache/trivy/fanal/`

Databases distributed as OCI images:

- `ghcr.io/aquasecurity/trivy-db:2` (vulnerability DB)
- `ghcr.io/aquasecurity/trivy-java-db:1` (Java DB)
- `ghcr.io/aquasecurity/trivy-checks:0` (policy bundle)

Update logic in `db.NeedsUpdate()` checks schema version compatibility, file existence, and staleness via `NextUpdate` timestamps. Daily updates by default.

### Grype: SQLite Blob Store (v6 Schema)

The v6 schema is a fundamental redesign:

- **Indexed tables** for fast lookups: `affectedPackageStore`, `affectedCPEStore`, `operatingSystemStore`
- **Blob table** for full vulnerability details: pseudo content-addressable storage where record IDs map 1:1 to JSON content digests
- **Separation**: Small indexed records point to blobs; full JSON loaded only on match

Key design decisions:

- Eliminated "namespaces" entirely; replaced with normalized lookup tables
- JSON blobs inspired by OSV schema but tailored to Grype
- Switched to zstandard compression (65MB vs 210MB downloads with gzip)
- GORM as ORM layer; `AutoMigrate()` for schema initialization
- `withCacheContext()` wraps DB operations with per-scan in-memory cache

Schema versioning: `ModelVersion` (6), `Revision` (1), `Addition` (1).

Dual-distribution approach for v5/v6 backward compatibility.

### Trivy Operator: Kubernetes CRDs

Seven CRDs store scan results directly in the Kubernetes API:

| CRD                       | Scope      | Purpose                 |
| ------------------------- | ---------- | ----------------------- |
| `VulnerabilityReport`     | Namespaced | Container image vulns   |
| `ConfigAuditReport`       | Namespaced | Config compliance       |
| `ExposedSecretReport`     | Namespaced | Secrets in images       |
| `SbomReport`              | Namespaced | SBOM data               |
| `RbacAssessmentReport`    | Namespaced | RBAC violations         |
| `InfraAssessmentReport`   | Namespaced | Infrastructure findings |
| `ClusterComplianceReport` | Cluster    | Compliance benchmarks   |

Two-tier storage: primary in K8s API (CRDs), alternative filesystem when API storage is constrained.

### Anchore Enterprise: PostgreSQL-Backed

- All service state in PostgreSQL (13.0+)
- `SimpleQueue`: PostgreSQL-backed queue for async task execution
- Default 30 connections per service pool
- Production: managed DB services (RDS, Cloud SQL, Azure SQL), not containerized PostgreSQL
- Object storage offload to S3/Swift/MinIO for large artifacts

**Actionable pattern**: Use a lightweight embedded DB (SQLite/BoltDB) for single-instance; PostgreSQL for multi-instance production. Separate indexed lookup fields from full result blobs. Distribute DB updates as versioned archives with integrity checks.

---

## 3. API Design

### Trivy Server: Twirp RPC

Two Twirp services mounted on an HTTP mux:

**Scanner Service** (`/twirp/trivy.scanner.v1.Scanner/`):

```
rpc Scan(ScanRequest) returns (ScanResponse)

ScanRequest: target, artifact_id, blob_ids[], options (ScanOptions)
ScanResponse: os, results[] (vulnerabilities, misconfigs, secrets, packages), layers[]
```

**Cache Service** (`/twirp/trivy.cache.v1.Cache/`):

```
rpc PutArtifact(PutArtifactRequest) returns (Empty)
rpc PutBlob(PutBlobRequest) returns (Empty)
rpc MissingBlobs(MissingBlobsRequest) returns (MissingBlobsResponse)
rpc DeleteBlobs(DeleteBlobsRequest) returns (Empty)
```

Additional HTTP endpoints:

- `GET /healthz` -- returns `"ok"` plaintext
- `GET /version` -- returns JSON version info

Token-based auth via custom header; empty token disables auth. Both services wrapped with gzip compression (`gziphandler.GzipHandler`).

### GitHub Code Scanning API: REST

Comprehensive REST API with `application/vnd.github+json` content type:

**Alert Management:**

- `GET /repos/{owner}/{repo}/code-scanning/alerts` -- list, filter by tool/severity/state
- `GET /repos/{owner}/{repo}/code-scanning/alerts/{number}` -- single alert
- `PATCH /repos/{owner}/{repo}/code-scanning/alerts/{number}` -- update status (dismiss, reopen)
- `GET /repos/{owner}/{repo}/code-scanning/alerts/{number}/instances` -- alert instances

**SARIF Upload:**

- `POST /repos/{owner}/{repo}/code-scanning/sarifs` -- upload (Base64-compressed SARIF, commit_sha, ref)
- `GET /repos/{owner}/{repo}/code-scanning/sarifs/{id}` -- upload status

**Analysis Management:**

- `GET/DELETE /repos/{owner}/{repo}/code-scanning/analyses/{id}`

Pagination: `page` (default 1), `per_page` (default 30, max 100), cursor-based with `before`/`after`.

Rate limiting: 1,000 requests/hour for SARIF upload per user/app installation.

Alert states: `open`, `dismissed`, `fixed`.
Dismissed reasons: `false positive`, `won't fix`, `used in tests`.
Severities: `critical`, `high`, `medium`, `low`, `warning`, `note`, `error`.

Versioning via header: `X-GitHub-Api-Version: 2026-03-10`.

**Actionable pattern**: For a scanning service, expose both RPC (Twirp/gRPC for internal scanner communication) and REST (for external integrations, dashboards). Keep health and version endpoints as simple HTTP handlers separate from the RPC mount. Use token-based auth with configurable headers.

---

## 4. Concurrent Scans and Queue Management

### Trivy

- **Filesystem cache limitation**: Default filesystem cache does not support concurrent writes, leading to race conditions
- **Redis cache** (`--cache-backend redis://...`): Enables concurrent scan execution by sharing cache across instances
- **Memory cache** (`--cache-backend memory`): Per-process cache for concurrent image scanning, no persistence
- **Parallel layer processing**: `--parallel N` controls layer-level parallelism within a single scan (default: parallel; use `--parallel 1` for disk-constrained environments)
- **Wait groups** for DB update serialization: `dbUpdateWg` blocks new requests during DB file swaps; `requestWg` drains in-flight requests before DB operations

### Trivy Operator (Kubernetes)

- **`jobs.LimitChecker`**: Enforces per-namespace and cluster-wide concurrency limits
- Active job tracking before creating new scan jobs
- Backpressure: queues scan requests when limits reached
- Controller-runtime work queue with exponential backoff for failed reconciliations
- Configurable: `concurrentScanJobsLimit` (e.g., 3), `scanJobTimeout`

### Grype

- **No built-in concurrency**: Sequential matcher execution, one-per-package
- SQLite with WAL mode for concurrent reads; GORM handles connection synchronization
- Designed as a CLI tool, not a server; concurrency managed by the caller (CI system, orchestrator)

### Anchore Enterprise

- **PostgreSQL-backed SimpleQueue**: All async task execution, notifications, operations
- **Analyzer scaling**: 4:1 ratio of analyzers to core services recommended (e.g., 16 analyzers : 4 API/catalog/queue/policy services)
- One analyzer processes one artifact at a time; horizontal scaling = more analyzer instances
- Scratch space per analyzer: 3-4x the size of the largest image

**Actionable pattern**: For a scanning service, implement a bounded worker pool with configurable concurrency. Use a durable queue (PostgreSQL-backed or Redis) for scan requests. Track active scans to enforce limits. Use wait groups or mutexes to serialize resource-contended operations (DB updates). Trivy's pattern of `dbUpdateWg.Wait()` before each request + `requestWg` for drain is elegant.

---

## 5. Deployment Patterns

### Trivy Helm Chart (StatefulSet)

```yaml
# Key configuration
replicaCount: 1 # configurable for HA
image: aquasec/trivy
command: ["trivy", "server"]
containerPort: 4954

# Resources
resources:
  requests: { cpu: 200m, memory: 512Mi }
  limits: { cpu: 1, memory: 1Gi }

# Security
podSecurityContext:
  runAsUser: 65534
  runAsNonRoot: true
  fsGroup: 65534
containerSecurityContext:
  privileged: false
  readOnlyRootFilesystem: true

# Persistence
persistence:
  enabled: true
  size: 5Gi
  accessMode: ReadWriteOnce

# Probes
livenessProbe:
  httpGet: { path: /healthz, port: 4954 }
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 10 # generous for DB downloads
readinessProbe:
  httpGet: { path: /healthz, port: 4954 }
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3 # quicker removal from Service

# Service
service:
  type: ClusterIP
  port: 4954
  sessionAffinity: ClientIP # cache efficiency

# RBAC
automountServiceAccountToken: false
```

Production template: 3 replicas, 10Gi storage, Redis cache with 24h TTL, 2 CPU / 2Gi memory, TLS ingress, pod anti-affinity across nodes.

### Trivy Container Image Build

- **GoReleaser v2** orchestrates multi-platform builds
- `CGO_ENABLED=0` for static binaries
- Base image: Alpine Linux 3.23.0 with ca-certificates and git
- Multi-architecture: linux/{386,arm,amd64,arm64,s390x,ppc64le}, darwin/{amd64,arm64}, windows/amd64, freebsd/amd64
- Three registries: Docker Hub, GHCR, AWS ECR Public
- Cosign keyless signing via GitHub Actions OIDC + Fulcio + Rekor transparency logs
- CycloneDX SBOM attached to GitHub releases
- Canary builds from main branch with `:canary` tag

### Anchore Enterprise

- Distributed containerized services
- Recommended topology: API + Catalog + Queue + Policy Engine (core), Analyzers (workers, scale independently)
- Single PostgreSQL dependency
- Object storage offload (S3/Swift/MinIO)
- Managed DB for production (not containerized PostgreSQL)

**Actionable pattern**: Use StatefulSet for services with persistent vulnerability DBs. Separate the scan worker from the API server for independent scaling. Use non-root, read-only root filesystem, dropped capabilities. Keep health probes asymmetric (generous liveness, strict readiness). Session affinity for cache efficiency.

---

## 6. Health Checks and Readiness Probes

### Trivy

- `GET /healthz` returns `"ok"` -- simple liveness/readiness check
- Liveness: `failureThreshold: 10` (allows time for large DB downloads on startup)
- Readiness: `failureThreshold: 3` (quick removal from service endpoints)
- Both use `initialDelaySeconds: 5`, `periodSeconds: 10`

### General Pattern

A production scanner should differentiate:

- **Liveness**: "Is the process alive?" (basic HTTP response)
- **Readiness**: "Can it serve traffic?" (DB loaded, dependencies reachable)
- **Startup**: "Has initial setup completed?" (DB download, cache warm-up)

**Actionable pattern**: Implement `/healthz` (liveness), `/readyz` (readiness that checks DB loaded + cache backend reachable), and optionally `/startupz` for slow-starting services with large initial DB downloads.

---

## 7. Graceful Shutdown

### Trivy Server Implementation

```go
// Signal handling triggers context cancellation
case <-ctx.Done():
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Errorf("Server shutdown error: %v", err)
    }
    cancel()
    return
```

**Two-waitgroup pattern** for in-flight request management:

```go
withWaitGroup := func(base http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        dbUpdateWg.Wait()     // Block if DB update in progress
        requestWg.Add(1)      // Track this request
        defer requestWg.Done()
        base.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

- `dbUpdateWg`: Blocks new requests during DB file swaps
- `requestWg`: Drains in-flight requests before DB operations proceed
- 30-second shutdown timeout (matches Kubernetes default termination grace period)
- HTTP server `ReadHeaderTimeout: 10 * time.Second` prevents slowloris attacks

**Actionable pattern**: Use `http.Server.Shutdown()` with a bounded context timeout. Track in-flight requests with a WaitGroup. Coordinate DB updates with request processing using a separate WaitGroup. Set `ReadHeaderTimeout` to prevent slow client attacks.

---

## 8. Configuration Hierarchy

### Trivy: Three-Tier with Viper

Precedence (highest to lowest):

1. **CLI flags** -- `--severity CRITICAL`
2. **Environment variables** -- `TRIVY_SEVERITY=CRITICAL` (prefix `TRIVY_`, uppercase, underscores)
3. **Configuration file** -- `trivy.yaml` (default: current directory)

Implementation:

- Generic `Flag[T]` type: `Name`, `ConfigKey` (dot notation), `Default`, `Aliases`
- Supports: `int`, `string`, `[]string`, `bool`, `time.Duration`, `float64`
- `PersistentPreRunE` hook: `BindPFlag()` + `BindEnv()` + `ReadInConfig()` + `ToOptions()`
- Backward compat via alias system (deprecated flags warn, removed flags error)
- Config-only options: empty `Name` field, skip CLI registration

Config categories: Global, Database, Scanning, Reporting, Vulnerability, Misconfiguration, Secret, License.

### Grype: Viper-Based with XDG

Config file search order:

1. `./.grype.yaml`
2. `./.grype/config.yaml`
3. `~/.grype.yaml`
4. `$XDG_CONFIG_HOME/grype/config.yaml`

Environment variables: `GRYPE_` prefix, e.g., `GRYPE_DB_AUTO_UPDATE=false`.

Rich configuration sections: `log`, `dev`, `output`, `search`, `match` (per-ecosystem CPE toggles), `db`, `registry` (multi-credential auth), `ignore` (vulnerability/package rules), `external-sources`, `vex-documents`, `fix-channel`, `alerts`, `fail-on-severity`.

### CodeQL

Configuration via:

1. Workflow YAML (`.github/workflows/codeql.yml`)
2. CodeQL configuration file (query suites, paths to include/exclude)
3. Default setup (auto-configured via GitHub UI/API)
4. `PATCH /repos/{owner}/{repo}/code-scanning/default-setup` API

**Actionable pattern**: Implement three-tier config (CLI > env > file) using Viper or equivalent. Use a consistent env var prefix (`NPMGUARD_`). Support YAML config file with `--config` override. Use a generic typed flag system for type safety across all sources. Include a `config-default` command to generate documented config files.

---

## 9. Timeout Management

### Trivy

- Default scan timeout: **5 minutes** (`--timeout 5m0s`)
- Configurable via `--timeout` flag
- Large images: increase timeout, reduce parallelism (`--parallel 1`), skip unnecessary files (`--skip-files`, `--skip-dirs`)
- `ReadHeaderTimeout: 10s` on HTTP server

### Grype

- `db.update-available-timeout`: 30s (metadata download)
- `db.update-download-timeout`: 5m (database download)
- `db.max-update-check-frequency`: 2h (rate-limit remote checks)

### CodeQL

- Per-language analysis with no documented hard timeout
- Resource-dependent: 2-8 cores, 8-64GB RAM depending on codebase size
- GitHub Actions job timeout applies (default 6 hours)

**Actionable pattern**: Set per-scan timeouts with generous defaults (10-15 minutes for complex packages). Use context-based cancellation propagated through all pipeline phases. Separate timeouts for: DB operations, scan execution, report generation. Expose timeout as a top-level config option.

---

## 10. Result Format Standardization

### SARIF 2.1.0 (Industry Standard)

Required structure:

```json
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "ToolName",
          "rules": [
            {
              "id": "RULE-001",
              "shortDescription": { "text": "..." },
              "fullDescription": { "text": "..." },
              "help": { "text": "...", "markdown": "..." },
              "defaultConfiguration": { "level": "error" },
              "properties": {
                "security-severity": "9.8",
                "tags": ["security", "cwe-79"]
              }
            }
          ]
        }
      },
      "results": [
        {
          "ruleId": "RULE-001",
          "message": { "text": "..." },
          "level": "error",
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "src/index.js" },
                "region": {
                  "startLine": 42,
                  "startColumn": 5,
                  "endLine": 42,
                  "endColumn": 30
                }
              }
            }
          ],
          "partialFingerprints": {
            "primaryLocationLineHash": "abc123..."
          }
        }
      ]
    }
  ]
}
```

GitHub limits:

- 10 MB per gzip-compressed SARIF file
- 25,000 results per run (top 5,000 by severity kept)
- 25,000 rules per run
- 20 runs per file
- 1,000 requests/hour rate limit for SARIF upload

### CycloneDX

OWASP standard supporting: SBOM, VDR (Vulnerability Disclosure Reports), VEX (Vulnerability Exploitability eXchange). Formats: JSON, XML, Protocol Buffers.

VEX statuses: `not_affected`, `affected`, `under_investigation`, `fixed`.

### Grype Output Presenter Architecture

Strategy pattern: each format implements transformation independently.

`Document` model feeds all presenters:

- `matches[]` -- vulnerability match objects
- `source` -- scanned target info
- `distro` -- OS distribution
- `descriptor` -- scan execution metadata

Presenters: Table, JSON, SARIF, CycloneDX, Template (custom Go templates).

`--show-suppressed` flag adds suppressed vulnerabilities with annotations.

**Actionable pattern**: Support multiple output formats via a presenter/writer pattern. Always support SARIF for GitHub/tool integration and JSON for programmatic consumption. Use a shared Document/Report model that all presenters consume. Support custom Go templates for extensibility.

---

## 11. Webhook / Notification Integrations

### GitHub Code Scanning

Webhook event: `code_scanning_alert`

Actions: `created`, `reopened`, `reopened_by_user`, `fixed`, `closed_by_user`.

Payload includes: `alert.number`, `alert.state`, `alert.rule.severity`, `alert.html_url`, `alert.most_recent_instance.location`, `repository.full_name`, `sender`.

### Anchore Enterprise

- PostgreSQL-backed notification queue in `SimpleQueue` service
- Notifications triggered by policy evaluation changes, vulnerability updates
- Webhook delivery to configured endpoints

**Actionable pattern**: Emit webhook events for scan lifecycle: `scan.started`, `scan.completed`, `scan.failed`. Include verdict, severity, package info in payload. Support configurable webhook URLs with retry logic and HMAC signing.

---

## 12. Multi-Tenancy Patterns

### Anchore Enterprise

- Account-level data isolation: data, policies, notifications, users separated into distinct domains
- All within shared PostgreSQL instance (logical separation, not physical)

### GitHub Advanced Security

- Organization-level security configurations applied across repositories
- Enterprise-level phased rollout (six core phases)
- Per-repository, per-organization, per-enterprise scoping
- Role-based access: security managers at org level

### Trivy/Grype

- No built-in multi-tenancy (CLI tools, single-user by design)
- Trivy server: token-based auth, but no tenant isolation
- Multi-tenancy implemented at the orchestration layer (Trivy Operator with namespace-scoped CRDs)

**Actionable pattern**: For multi-tenant scanning, implement at the API layer: tenant ID in JWT/token, tenant-scoped result storage, tenant-specific rate limits. Use logical separation in the database (tenant_id column) rather than separate databases. Namespace-scoping in Kubernetes is a natural multi-tenancy boundary.

---

## 13. Caching Strategies

### Trivy

**Layer-level caching** (the primary performance optimization):

- `MissingBlobs()` RPC checks which image layers are already cached
- Only uncached layers go through analysis
- Cache key: layer diff ID (content-addressable)

**Three cache backends**:

1. **Filesystem** (`~/.cache/trivy/`): Default, single-process only
2. **Redis** (`--cache-backend redis://...`): Distributed, supports concurrent access, configurable TTL
3. **Memory** (`--cache-backend memory`): Per-process, no persistence, concurrent-safe

**Database caching**: BoltDB file cached locally; separate from scan result cache. Updated daily from OCI registry.

### Grype

- **Per-scan in-memory cache**: `withCacheContext()` wraps GORM operations
- Caches `OperatingSystem`, `Provider`, `Package` lookups within a single scan session
- No persistent scan result cache; no distributed cache
- **Database cache**: Local SQLite file, updated via curator with 2-hour check frequency limit

### Trivy Operator

- CRD-based result caching: scan results stored as K8s resources
- **TTL-based expiration**: `TTLReportReconciler` deletes stale reports (default 24h)
- **Policy hash tracking**: Reports invalidated when policy ConfigMap changes
- **Owner references**: Automatic cleanup when source workloads are deleted

**Actionable pattern**: Cache at the artifact/package level, not just the scan level. Use content-addressable keys (package hash/digest). Support both local (filesystem/memory) and distributed (Redis) backends. Set TTLs on cached results. Invalidate cache on DB/policy updates. For a scanning service: cache the SBOM/package inventory separately from the vulnerability assessment (inventory is stable; assessment changes when DB updates).

---

## 14. Database Migration Strategy

### Trivy

- **No backward compatibility** for old schema versions
- Schema version stored in `metadata.json` alongside the DB file
- On schema mismatch: download new DB, replace entirely
- `db.NeedsUpdate()` checks: schema version compatibility, file existence, staleness
- Air-gapped: manually provision DB at expected path

### Grype v5 to v6

- Complete schema redesign (not incremental migration)
- Dual-distribution: maintain both v5 and v6 endpoints for transition period
- Curator validates schema version + integrity (SHA256) + age on startup
- **Atomic replacement**: new DB downloaded to temp dir, validated, hydrated (indexes created), then atomically moved to production path
- `hydrate(dbDir, source, monitor)` function creates indexes after extraction
- `activate()` method coordinates the transition, preventing partial initialization

### General Pattern

Neither Trivy nor Grype use traditional SQL migrations (ALTER TABLE, etc.). Instead:

1. Database is treated as a **distributed artifact** (like a container image)
2. New schema = new database version, distributed as a new archive
3. Client validates schema version on startup
4. Incompatible schema triggers full re-download
5. Atomic file replacement prevents corruption

**Actionable pattern**: For a vulnerability DB that you build and distribute, treat it as an immutable artifact with schema versioning. For application state (scan results, user data), use traditional migrations (e.g., golang-migrate, Alembic). Keep these two storage concerns completely separate.

---

## Summary: Key Patterns for SkillGuard Production

| Concern      | Recommended Pattern                                                   | Source                  |
| ------------ | --------------------------------------------------------------------- | ----------------------- |
| Pipeline     | Phase separation (analyze > detect > report) with interfaces          | Trivy, Grype            |
| API Protocol | Twirp/gRPC for internal scanner RPC + REST for external               | Trivy                   |
| Health       | `/healthz` + `/readyz` with asymmetric failure thresholds             | Trivy Helm              |
| Shutdown     | `http.Server.Shutdown()` + dual WaitGroup (DB update + request drain) | Trivy server            |
| Config       | Three-tier (CLI > env > file) via Viper with typed Flag[T]            | Trivy                   |
| Concurrency  | Bounded worker pool + Redis-backed queue + per-namespace limits       | Trivy Operator, Anchore |
| Scan Cache   | Content-addressable (artifact digest), Redis for distributed          | Trivy                   |
| Result DB    | SQLite blob store (indexed handles + JSON blobs)                      | Grype v6                |
| Output       | SARIF 2.1.0 primary + JSON + custom templates via presenter pattern   | Grype, GitHub           |
| Deployment   | StatefulSet + PVC + Redis sidecar + pod anti-affinity                 | Trivy Helm              |
| Container    | Alpine base, CGO_ENABLED=0, non-root, read-only rootfs                | Trivy                   |
| DB Migration | Immutable artifacts with schema version + atomic replacement          | Grype v6                |
| Multi-tenant | Tenant ID in JWT, tenant-scoped storage, namespace isolation          | Anchore, GitHub         |
| Webhooks     | `scan.started/completed/failed` events with HMAC signing              | GitHub                  |
| Auth         | Token-based with configurable header, empty = disabled                | Trivy server            |
| Timeouts     | Per-scan context timeout (default 5-10m), separate DB timeout         | Trivy, Grype            |
| Signing      | Cosign keyless via OIDC + Fulcio + Rekor transparency log             | Trivy                   |

---

## Sources

- [Trivy GitHub Repository](https://github.com/aquasecurity/trivy)
- [Trivy Documentation](https://trivy.dev/docs/latest/configuration/)
- [Trivy DeepWiki Architecture](https://deepwiki.com/aquasecurity/trivy)
- [Trivy Helm Chart DeepWiki](https://deepwiki.com/aquasecurity/trivy/8.3-kubernetes-deployment-with-helm)
- [Trivy Configuration DeepWiki](https://deepwiki.com/aquasecurity/trivy/2.4-configuration-files-and-environment-variables)
- [Trivy Release Process DeepWiki](https://deepwiki.com/aquasecurity/trivy/9.3-release-process-and-distribution)
- [Trivy Client/Server Mode](https://trivy.dev/docs/latest/references/modes/client-server/)
- [Trivy RPC Cache Package](https://pkg.go.dev/github.com/aquasecurity/trivy/rpc/cache)
- [Trivy server listen.go](https://github.com/aquasecurity/trivy/blob/main/pkg/rpc/server/listen.go)
- [Trivy scanner service.proto](https://github.com/aquasecurity/trivy/blob/main/rpc/scanner/service.proto)
- [Trivy Operator GitHub](https://github.com/aquasecurity/trivy-operator)
- [Trivy Operator Scanning System DeepWiki](https://deepwiki.com/aquasecurity/trivy-operator/4-scanning-system)
- [Grype GitHub Repository](https://github.com/anchore/grype)
- [Grype Architecture DeepWiki](https://deepwiki.com/anchore/grype)
- [Grype DB System DeepWiki](https://deepwiki.com/anchore/grype/2.2-vulnerability-database-system)
- [Grype Output Formats DeepWiki](https://deepwiki.com/anchore/grype/4-output-formats)
- [Grype Configuration Reference](https://oss.anchore.com/docs/reference/grype/configuration/)
- [Grype DB Schema Evolution Blog](https://anchore.com/blog/grype-db-schema-evolution-from-v5-to-v6-smaller-faster-better/)
- [Anchore Enterprise Architecture](https://docs.anchore.com/current/docs/overview/architecture/)
- [Anchore Scaling Blog](https://anchore.com/blog/scanning-millions-scaling-with-anchore/)
- [GitHub Code Scanning API](https://docs.github.com/en/rest/code-scanning/code-scanning)
- [GitHub SARIF Support](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)
- [GitHub CodeQL Action](https://github.com/github/codeql-action)
- [CodeQL Hardware Requirements](https://docs.github.com/en/code-security/code-scanning/creating-an-advanced-setup-for-code-scanning/recommended-hardware-resources-for-running-codeql)
- [GitHub Webhook Events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [SARIF OASIS Specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
- [CycloneDX Standard](https://cyclonedx.org/)
- [CycloneDX VEX](https://cyclonedx.org/capabilities/vex/)
