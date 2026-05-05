# NpmGuard — Working Plan

_Last updated: 2026-05-05_

Living plan for current priorities. For detailed architectural direction see `docs/architecture/ARCHITECT_REVIEW_ENGINE.md`.

---

## Done (merged to main)

- Report viewer (FindingsList + ProofDetail + Runtime tab + download bundle)
- Benchmark v1 infrastructure (Datadog corpus, CRE polling runner, Wilson CI analyzer)
- Benchmark frontend dashboard (`/benchmark` page)
- Phase A: evidence schemas, sensors (L1-L4 + V8 inspector), manipulation primitives, `runUnderObservation`, sandbox Dockerfile
- Phase B: intent extraction, hypothesis-emitting triage, graph builder, finding→hypothesis correlation, experimenter worker (6 claim strategies), graph-authoritative verdict
- Engine reliability: MiniMax compat, tool output cap (32KB), Docker --user fix, timeout bumps (triage 5min, verify 15min), model name auto-prefix for OpenRouter

---

## Next priorities

### 1. Run Datadog benchmark against the new pipeline

Phase B's hypothesis-graph pipeline hasn't been validated against the full 50-100 fixture corpus. The experimenter adds a new evidence path — measure whether it improves recall over the old flat pipeline.

### 2. 4-state verdict + frontend hypothesis UI

`GraphVerdict` (SAFE/SUSPECT/DANGEROUS/UNKNOWN) exists internally but AuditReport still exposes 2-state. Cascade: shared schema → CLI → frontend VerdictBanner → hypothesis timeline in AuditView.

### 3. GitHub Action

`uses: NpmGuard/audit-action@v1` — runs on PRs touching `package-lock.json`, posts comment with verdicts. Highest-leverage distribution.

### 4. Remaining experimenter strategies

6/13 claim kinds have strategies (env_exfil, cred_theft, binary_drop, dos_loop, obfuscation, persistence, dns_exfil). Missing: dom_inject, clipboard_hijack, telemetry, propagation, destructive, build_plugin_exfil.

### 5. Report bundle layout

Flat `data/reports/<pkg>/<version>.json` → `report.json + artifacts/<hash>/` with content-addressed blobs from Phase A's artifact-store.

---

## Explicit no's

- AI chat with the report — distracts from the moat
- VS Code extension — harder than CLI for marginal reach
- Mainnet payment — testnet fine until real demand
- Mobile app — web works on mobile

---

## Operational gotchas

- **Datadog fixtures contain live malware.** `.gitignore`d (`sandbox/test-fixtures/test-pkg-bench-dd-*`), regenerated via `datadog:fetch`. Never commit. Never `npm install` outside bench tooling.
- **Deploy webhook is fragile**: use `git fetch && git reset --hard origin/main` in `deploy/pull-and-restart.sh` (not `git pull`).
- **`sandbox/` is not a workspace** — run `cd sandbox && npm install` once after fresh clones.
- **Engine logs**: `/var/log/npmguard.log` (not journalctl). Systemd unit has `StandardOutput=append:`.
- **Bench runs on prod engine** (port 8000) via CRE bypass. During a 4-6h run, user `/audit` calls queue behind. Acceptable at current volume.
- **L2 pcap is environmentally flaky** — tcpdump must be first exec in container. Documented in `docs/architecture/ARCHITECT_REVIEW_ENGINE.md`.
