# Testing

Two pillars: **prove the logic** (blackbox units over enumerated equivalence
classes) and **prove the artifact** (e2e: a real uvicorn engine on an ephemeral
port, throwaway DB, deterministic mocks behind real HTTP boundaries, replaying
real captured production LLM traffic).

**Clone-and-run rule:** `uv run pytest` passes on a fresh clone with nothing
running (units + in-process replay slices, seconds). Everything needing infra
gates on env vars or docker presence and skips with a visible reason. E2e is
the per-change gate (minutes), opt-in via `-m e2e`.

## Tiers

| tier | command (from `engine/`) | needs / gate |
|---|---|---|
| unit | `uv run pytest` | nothing (default excludes `e2e` and `llm_live`) |
| slice (recorded replay) | included in the default run (`tests/slice/`) | nothing — committed bundles |
| e2e sqlite | `uv run pytest -m "e2e and not docker and not postgres and not cli"` | nothing beyond deps |
| e2e + docker | `uv run pytest -m "e2e and docker"` | docker daemon + `npmguard-sandbox:v1` image; `NPMGUARD_TEST_DOCKER=0` forces off |
| e2e + postgres | `uv run pytest -m "e2e and postgres"` | `NPMGUARD_TEST_PG_DSN`, else a throwaway `postgres:17-alpine` container via docker, else loud skip |
| cli | `uv run pytest -m "e2e and cli"` | `cli/dist/` built (+ node on PATH; the DANGEROUS-verdict test also needs docker) |
| llm_live | `uv run pytest -m llm_live` | `NPMGUARD_TEST_LLM_LIVE=1` + a real key. Opt-in smoke, **never the gate**. Tier reserved; no tests exist yet |

Unit-tier postgres classes (`tests/test_payments.py`, `tests/test_events_sse.py`,
`tests/test_persistence.py`) gate on `NPMGUARD_TEST_PG_DSN` only — no docker
auto-provision inside the default suite. `scripts/gate.sh` provisions a
throwaway container and exports the DSN so the only honest concurrency proofs
(C10, SSE fanout) actually run at the gate. SQLite serializes writers, so a
"concurrent" claim proof under sqlite is vacuous; Postgres MVCC is the axis
where races are real. Both are prod engines.

Test-only engine knobs (all default to prod behavior when unset):
`NPMGUARD_DATA_DIR`, `NPMGUARD_AUDIT_LOG_DIR`, `NPMGUARD_NPM_REGISTRY`,
`NPMGUARD_STRIPE_API_BASE`, `NPMGUARD_QUEUE_SIZE`,
`NPMGUARD_MAX_RUNNING_SESSIONS`. The e2e harness sets a **fully explicit** env
(inherited `NPMGUARD_*` stripped, data/audit-log dirs always tmpdirs), so no
test can write `engine/data/` or `engine/audit-logs/`; an import-time guard in
`tests/conftest.py` enforces the same for in-process tests.

## Pillar A — blackbox units over equivalence classes

The unit is every exported function/class; private helpers are covered through
the public I/O that uses them. Blackbox: assert only inputs, outputs, and
observable effects (DB rows, files, HTTP, events). No `provider._calls`, no
private imports — where a boundary constant isn't injectable, tests move it
observably through the module seam and say so.

**Class map:** every test file opens with the enumeration of its unit's input
classes; every test names its class in the docstring's first line (`C3: ...`).
Review checks the map, not the test count — a missing class is visible, a
missing assertion is not.

**Adversarial pass:** a map is not trusted until a different session/model asks
one question — *which dimension is missing?* — and the header records the
answer. The pass that produced the current maps added the DB-engine axis,
bounds that never fire (queue/session caps), launch-path parity, and the
shutdown lifecycle; those are now scenarios S24–S37 (S36 is the DB-engine
matrix *rule*, realized as the sqlite/postgres parametrizations and DSN-gated
classes rather than a single test id).

E2e scenario files use the same convention with scenarios as classes; every e2e
test docstring carries `S<id> [C<claims>]`.

## Pillar B — e2e: the artifact, proven

`tests/support/harness.py` spawns `uv run --frozen uvicorn npmguard.api:app` in
its own process group, waits on `/health` (bounded, stderr tail on failure),
and offers `restart()` (SIGKILL group + respawn, same port/db) and `close()`
(SIGTERM + grace, returns a graceful flag). Stubs are real HTTP servers on
port 0 (`tests/support/stubs.py`): registry (serves committed packuments +
tarballs, rewrites `dist.tarball` to itself), fake chain JSON-RPC (real
ABI-encoded `AuditRequested` logs; delayed/reverted/wrong-event modes), stripe
(via the `stripe_api_base` seam). SSE assertions go through the bounded frame
parser in `tests/support/sse.py`. httpx `ASGITransport` buffers whole bodies —
live SSE follow needs the real uvicorn; in-process tests consume the
`sse_events` generator directly.

The mock LLM (`tests/e2e/llm_mock.py`) serves `POST /v1/chat/completions` from
committed bundles plus scripted role fallbacks, controlled over
`/_mock/{load,reset,status,unmatched}`. Every scenario teardown asserts zero
unmatched requests and required exchanges consumed — an unexpected prompt is a
500 to the engine (the audit ERRORS, never goes SAFE) *and* a spooled body for
diagnosis.

## Replay fixtures — real captured traffic

Bundles live at `tests/fixtures/llm/<pkg>@<ver>/`:

```
manifest.json                    # provenance, expectedVerdict (curator truth),
                                 # models, per-role prompt {version, hash} pins,
                                 # exchange index with sha256s
exchanges/<seq>_<role>_<sha8>.json   # kit {request,response} envelope, one per attempt
sandbox/<hypothesisId>.runartifact.json  # recorded sandbox runs for slice replay
```
plus `llm/_extras/transport/` (synthesized timeout/provider_error/truncated),
`llm/PINNED.json` (curated audit-id pins + expected verdicts + bans),
`llm/ALLOWLIST.json` (justified secret-scan hits), `fixtures/sse/*.skeleton.json`
(event-type skeletons — never byte goldens; seq/ts are nondeterministic).

**Matching is content-addressed:** key `(model, sha256(canonical(messages)))`
with a per-key ordered cursor, so the 8-way concurrent flag phase replays at
prod concurrency (a FIFO queue would force concurrency 1). After a key hit the
full body is verified via kit's `_match_subset` plus a
`response_format.json_schema.name == role` pin. Repair retries extend the
transcript, so invalid→repair pairs are two different keys — the repair path
replays for real.

**Prompt drift fails loud:** the manifest pins each role's prompt hash; loaders
recompute via `kit_llm.prompts.load_prompt` and raise `FixturePromptDrift` on
mismatch. Editing anything under `prompts/` therefore requires re-recording —
without the pin, drift would surface as an opaque wall of unmatched 500s.

**Re-record runbook** (needs a real provider key + docker for DANGEROUS runs):

1. Local engine, real provider: `NPMGUARD_LLM_API_KEY=<real>`, payment off,
   throwaway sqlite + `NPMGUARD_DATA_DIR`/`NPMGUARD_AUDIT_LOG_DIR` scratch dirs.
2. Run the audit via `POST /audit/stream`; capture lands in `llm_attempts`
   automatically (kit capture).
3. Curate: verify the verdict is *correct* (recorded prod outcomes include
   false positives/negatives — never pin a wrong verdict), then pin the
   audit_id + expectedVerdict in `tests/fixtures/llm/PINNED.json`.
4. Export: `uv run python -m tools.export_fixtures --from-db <sqlite> --pinned
   tests/fixtures/llm/PINNED.json --audit-logs <dir> --out tests/fixtures/llm`
   (strips cache keys/costs/call ids, refuses bench-dd content absolutely,
   records secret-scan hits for the allowlist).
5. Lint: `uv run python -m tools.fixture_lint` (provenance, sha256s, prompt
   pins, strict-role responses parse under the CURRENT pydantic contracts,
   judge citations ⊆ rendered timeline, size caps: 1.5MB/bundle warn,
   8MB fixtures-tree hard).
6. Dry replay: run `tests/slice/test_replay_slices.py` — the bundle must
   reproduce its pinned verdict with zero unmatched.
7. Commit the bundle and `PINNED.json` together.

## Judge determinism — why two tiers

Replaying a recorded judge exchange against a **live** docker run is
impossible: the judge prompt embeds the rendered timeline (runId, wall-clock,
event order), and sandbox network capture is structurally nondeterministic.
So:

- **Slice tier** (`tests/slice/`): recorded hypotheses + `RecordedSandbox`
  injecting recorded runartifacts (keyed by hypothesis id — deterministic,
  ids come from replayed responses) + the judge replayed content-matched.
  Judge *logic* is proven here against real recorded data.
- **E2e docker tier**: recorded pre-sandbox chain + LIVE docker experiments +
  a content-aware **scripted** judge that parses real event ids from the
  incoming timeline and returns a schema-valid verdict citing them (labeled
  `synthesized`). E2e proves the seams, not the judge's judgment.
- Recorded **agent** (tool-loop) exchanges replay only at the slice tier: a
  live re-entry diverges from the recording at the first turn (tool results
  embed live state), observed empirically for the dns-exfil bundle.

## Claims are test targets

Every falsifiable claim in `CLAUDE.md` maps to named tests, or is labeled
honestly. `UNENFORCED` marks policy without a mechanism — enforced and
aspirational rules never share a grammar.

| claim | proven by |
|---|---|
| C1 real-version filenames, never a `latest.json` alias | `test_report_store.py::test_real_inventory_version_names_the_file` / `::test_no_version_anywhere_is_an_error_not_latest_json`; e2e `test_persistence_e2e.py::test_report_persisted_under_real_version_never_latest` |
| C2 SQL owns sessions/replay/claims | `test_lifecycle.py::test_payment_claim_survives_restart`, `::test_restart_mid_run_emits_retryable_error_on_resumed_cursor`, `test_events_sse.py::test_events_durable_across_engine_instances`. Capture-ownership sub-claim: e2e `test_verdicts.py::test_s1_clean_safe_via_registry` asserts post-audit `llm_runs` rows keyed by the auditId (intent + flag roles), each with joined `llm_attempts` rows |
| C3 failure is ERROR, never SAFE | `test_failures.py::test_s16a/b/c…`, `::test_s17_sandbox_broken_defers_to_incomplete`, `::test_s18_package_not_found` |
| C4 cleared only by full-oracle run + evidence | `test_orchestrator_success.py::test_refuted_records_evidence_artifact`; e2e `test_verdicts.py::test_s2_dangerous_confirmed_live_docker`, `::test_s3_all_refuted_is_safe` |
| C5 exactly-3 payment paths, never launch pre-claim | `test_payments_flow.py::test_valid_chain_tx_claims_and_launches`, `::test_invalid_receipt_matrix_rejects_and_leaves_no_rows` (zero rows after each 402), `::test_payment_gate_and_cre_key`, `::test_webhook_claims_once_across_replays`. Stripe stream-verify leg: `::test_stream_verifies_paid_stripe_session`, `::test_claimed_stripe_session_is_idempotent`; the S26 webhook-vs-stream race requires BOTH sides 200 with the winner's auditId |
| C6 legacy-compatible wire format | `test_stream.py::test_s11_cold_connect_wire_format`; `test_events_sse.py::test_wire_format_flattens_payload_into_envelope` |
| C7 `/api` mirrors | `test_api.py` base-URL parametrization `["", "/api"]` across three families; e2e spot-checks |
| C8 MOCK_LLM never for real audits | `test_payments_flow.py::test_mock_llm_in_prod_refuses_to_start` (+ dev-boots pair) — enforced by the F3 boot invariant |
| C9 restart → explicit retryable errors | `test_lifecycle.py::test_restart_mid_run_emits_retryable_error_on_resumed_cursor`, `::test_restart_mid_queue_fails_queued_sessions_too`; `test_service_queue.py` recovery classes |
| C10 `(chain, txHash)` exactly-once, concurrent + restart | `test_payments.py::test_concurrent_claims_exactly_once_postgres` (the only honest race proof — DSN-gated), `::test_claim_durable_across_engine_restart`; e2e `test_payments_flow.py::test_concurrent_same_tx_single_claim[sqlite/postgres]` |
| C11 receipt event matches (pkg, version) | `test_payments.py::test_package_name_mismatch_rejected`, `::test_version_mismatch_rejected`, `::test_multiple_logs_one_matching_accepted` |
| C12 SAFE installs / DANGEROUS warns | `test_cli.py::test_checkout_501_falls_back_to_free_audit_safe_exit_0`, `::test_dangerous_verdict_exits_1`; `test_persistence_e2e.py::test_cli_short_circuits_on_existing_report`. Interactive DANGEROUS prompt: **EXCLUDED** (TTY-bound, manual) |
| C13 live events in terminal after payment | `test_cli.py` (all three stream the verdict over live SSE) |
| C14 incomplete = retryable AuditIncompleteError | `test_failures.py::test_s17…` (NPMGUARD-0031, retryable:true); `test_orchestrator_success.py::test_deferred_never_aggregates_safe` |
| C15 CONFIRMED→DANGEROUS / REFUTED→SAFE / DEFERRED→error | `test_orchestrator_success.py::test_all_refuted_aggregates_safe`, `::test_any_confirmed_aggregates_dangerous`, `::test_deferred_never_aggregates_safe`; e2e S2/S3/S17; slice `test_replay_slices.py` |
| C16 late-join replay | `test_stream.py::test_s12…`, `::test_s13_resume_via_last_event_id_and_since`, `::test_s15_finished_audit_drains_and_closes` |
| C17 receipt is waited for, not fetched once | `test_payments.py::test_delayed_receipt_is_polled_for_not_fetched_once` (stub delay + observed poll count — never a wall-clock 30s); e2e `test_payments_flow.py::test_delayed_receipt_still_verifies` |

## Determinism

No sleep-and-assert — wait on conditions with bounded timeouts; latency bounds
are named constants, generous for CI, never load-bearing. Negative assertions
are bounded and paired with a positive probe. Tests share no mutable state.
Wall-clock waits the engine hardcodes (30s receipt wait, 15s heartbeat) are
never burned: timing is proven at stub/seam level (delayed receipt + poll
count; injected 0.2s heartbeat). PIN tests document current divergent behavior
with an `UNENFORCED`/finding comment instead of silently blessing it; xfail
pins assert the *correct* contract so they flip green when the bug is fixed.

## Failure protocol

| failure | meaning | the move |
|---|---|---|
| unit | bug — or the class map missed a class | fix the code; if the map was wrong, add the class **first** |
| slice | replay drift (prompt/contract/fixture) | `FixturePromptDrift` → re-record; contract change → re-export + lint |
| e2e | boundary bug | fix the seam; never mock it away |

Every bug that escapes names its missing equivalence class; the fix adds that
class to the map before touching the code. Never weaken a test to pass — if a
test encodes the wrong convention, change the convention's document first.

## Exclusions (deliberate, with reasons)

- Multi-replica engine: in-memory queue is single-worker by design.
- Real Stripe / real chain / real LLM providers: metered externals — opt-in
  smoke only, never the gate.
- WalletConnect UX: the engine-side class is covered by the fake chain.
- bench-dd malware fixtures in CI: banned from committed files by policy.
- Interactive TTY prompt (DANGEROUS confirm): manual; `--force` branch covered.
- Frontend rendering: mid-rewrite, reference-only.
- nginx SSE buffering: deploy config (no-ephemeral-facts rule).
- Real-scale load: bounds tested shrunken via `NPMGUARD_QUEUE_SIZE`/`…_MAX_RUNNING_SESSIONS`.
- sqlite corruption / disk-full: tests the OS, not the engine.

## FINDINGS

Open (report-only; tracked here, not silently fixed):

- **CLI exit-0-on-CLOSED hazard** (`cli/` scope, out of engine): `es.onerror`
  resolves verdict UNKNOWN / exit 0 when EventSource reaches readyState CLOSED
  (e.g. a 404 events URL) — a missing audit session exits 0. Untested: no
  engine path produces the repro naturally.
- **Docker leak on worker-cancel** (`service.py` → `observation.py`,
  pre-existing, UNVERIFIED): when `close()` cancels a worker mid-`_execute`,
  `CancelledError` propagates past `_execute`'s `except Exception`; whether an
  in-flight sandbox container is torn down before the task dies is untraced.
  Worth a dedicated check; unrelated to the lifecycle rework.
- **Reports-vs-DB desync** (observed on the prod snapshot that seeded the
  fixture corpus): report files existed with no matching audit session, and
  11 deterministic child-success smoke runs left audit-log dirs with no
  session/report. Nothing ties `data/reports/` to `audit_sessions`; a
  consistency invariant is a maintainer decision.
- **is-number recording predates the defer rule**: its pinned artifacts now
  all DEFER under the current unresolved-module rule, so the recorded SAFE is
  unreachable — the slice pins this as a finding
  (`test_replay_slices.py::test_is_number_stale_artifacts_defer_under_current_rule`).

Config note — **`NPMGUARD_MAX_RUNNING_SESSIONS` is now a hard concurrency cap.**
Since the single-owner rework it sizes the worker pool: the maximum number of
audits (hence Docker sandboxes) executing at once, not a soft session-row cap.
The default (100) far exceeds what a small host can hold; set it to the number
of concurrent full-oracle sandboxes the deployment's RAM allows.

Fixed since first tracked (regression-enforced, no longer open):

- **Launch-lifecycle cluster → single execution owner.** Paid audits bypassing
  the session cap, `enqueue` check-then-act, `close()` orphaning the queued
  item, the unbounded shutdown await, and `/audit/stream` bypassing the queue
  were all instances of one root cause: five session-creation paths with no
  execution owner, so `status='running'` promised nothing. Fixed by funnelling
  every path through `AuditService.submit`/`admit`: `status` splits
  `queued`/`running` (running ⟺ an owned worker will finalize it); a bounded
  wait queue feeds a fixed `max_concurrent` worker pool; paid audits QUEUE and
  are refused (503, before the payment is claimed) only when the queue is full;
  `reserve`-then-create removes the check-then-act; `close(deadline)` resolves
  every future and leaves no `running` row; restart re-enqueues durable
  `queued` rows so a claimed paid audit is never dropped. The adversarial pass
  additionally closed a graceful-shutdown drop (a clean restart used to error
  queued paid audits while a crash resumed them) and a concurrent-retry
  spurious 500. Enforced: `test_service_queue.py` (queued / admission /
  idempotent-submit / recovery / bounded-close classes), `test_persistence.py`,
  and e2e `test_lifecycle.py` (S31/S32), `test_bounds_inputs.py` (S24/S25),
  `test_stream.py`, `test_payments_flow.py`.
- **Terminal event precedes durable persistence** → fixed: `finalize` is a
  guarded `running→terminal` transition committed in one transaction with the
  terminal SSE event, after the report is saved — so a terminal frame implies a
  durable report. Enforced: the `test_persistence.py` / `test_service_queue.py`
  durability classes; the S29 flake is gone at the source (the `waits.py`
  helpers are now instant).
- **`resolve` mutated the committed fixture tree** → fixed: resolve returns a
  private disposable workdir (fixtures copied into a tmpdir; escaping symlinks
  rejected as for tarballs, closing a live-malware host-escape). Enforced:
  `test_resolve.py`.
- **`extract_intent` fabricated on terminal errors** → fixed: `BudgetExhausted`
  and bugs propagate (a fallback intent is marked degraded); `run_hypothesize`
  asserts every flag is armed rather than dropping Nones. Enforced:
  `test_hypothesis_generation.py`.
- **Unarmed hypothesis aborted the whole run** → fixed: enforced at graph
  admission (`build_graph`), not dispatch, so one unarmed hypothesis no longer
  strands its siblings. Enforced: `test_hypothesis_agent.py` / `test_graph.py`.
- **pcap start race** → fixed: `start_pcap` waits for tcpdump's capture-ready
  marker (raises `SensorError` → DEFER on failure, never a silent empty
  capture), and the traced-syscall map is total (no fabricated `openat`).
  Enforced: `test_sensors.py` + the dns-exfil live-docker e2e still captures the
  DNS burst.
- **Stripe 15.x verify crash**: stripe 15.x `StripeObject` is not a dict, so
  `metadata.get(...)` raised for every metadata-bearing session → all
  Stripe-success flows 402. Fixed: `payments.py` reads metadata via a
  dict-or-getattr `_field()` (same pattern as the webhook path). Enforced:
  `test_payments.py` C18/C19/C23 (paid/unpaid/missing-metadata semantics) +
  the stripe e2e legs in the C5 row, now plain green.
- **Alembic drift** (`kit_llm/capture.py` vs shipped migrations): fixed by
  migration `0004_widen_llm_attempt_columns` (six `llm_attempts` columns →
  Text/BigInteger, batch-alter so sqlite recreates and postgres ALTERs).
  Enforced: `test_hypothesis_agent.py` C10 asserts an empty autogenerate diff
  on BOTH the migrated and created schemas.
- **Exact-filename load unguarded** (`report_store.py`): a corrupt
  `<version>.json` no longer raises — the exact hit is a fast path that falls
  through to the embedded-version scan (also closing the exists→read TOCTOU).
  Enforced: `test_report_store.py` C12 covers all three load paths.

## The gate

`scripts/gate.sh` — cheap first: ruff → default pytest (with a provisioned
postgres DSN when docker is available) → fixture lint → e2e sqlite → docker /
postgres / cli e2e tiers when their gates are open (loud notes when not).
Docker/postgres/cli tiers skipping locally is acceptable; they are required
before merge. To wire it as a pre-push hook:

```bash
ln -s ../../engine/scripts/gate.sh .git/hooks/pre-push   # from the repo root
```
