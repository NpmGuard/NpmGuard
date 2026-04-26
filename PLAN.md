# NpmGuard — Working Plan

_Last updated: 2026-04-27_

This is the working plan for the bench rollout and the next features. Lives
in the repo so any contributor — or any future Claude session — gets caught
up in 60 seconds.

---

## ✅ Done so far (recent merges to main)

- **Wave 1**: polished report viewer (FindingsList + ProofDetail tabs +
  AuditTrail + payment proof badge)
- **Wave 2**: runtime evidence captured from agent investigation traces +
  Runtime tab in ProofDetail
- **Wave 3**: download bundle (PDF / Markdown / JSON with audit certificate
  + on-chain hash footer)
- **Bench v1 — code**: methodology document, Datadog corpus pipeline (select
  / fetch / manifest), runner with CRE polling, analyzer with Wilson 95% CI
- **First successful Datadog audit**: `react-keycloak-context@1.0.8` (real
  Shai-Hulud worm sample) → DANGEROUS, 10 proofs, 1 TEST_CONFIRMED
- **3 engine fixes shipped along the way**: tool-read output cap (32 KB),
  triage timeout 2 min → 5 min, sandbox/ deps installed

---

## 🟡 In progress / immediately next

### 1. Run the full Datadog benchmark (1 night of compute)

50 fixtures × 3 runs = 150 audits, ~12-17h serial, ~$10-20 OpenRouter.
Procedure in `bench/README.md` and `~/.claude/projects/.../memory/bench-runbook.md`:

```bash
ssh root@209.38.42.28
cd /root/NpmGuard
git fetch origin && git reset --hard origin/main
bash deploy/pull-and-restart.sh

# Refresh corpus + fixtures
npm run -w @npmguard/bench datadog:select
npm run -w @npmguard/bench datadog:fetch
npm run -w @npmguard/bench datadog:manifest

# Read CRE key (already in .env on the droplet)
CRE_KEY=$(grep '^NPMGUARD_CRE_API_KEY=' /root/NpmGuard/engine/.env | cut -d= -f2)

# Full run in nohup
nohup npm run -w @npmguard/bench run -- \
  --api http://localhost:8000 \
  --api-key "$CRE_KEY" \
  --runs 3 \
  > /tmp/bench-run.log 2>&1 &
echo $! > /tmp/bench-run.pid

# 12-17h later: analyze
RESULTS=$(ls -t /root/NpmGuard/bench/results/*.json | head -1)
npm run -w @npmguard/bench analyze -- --results "$RESULTS"
cat "${RESULTS%.json}-summary.md"
```

**Output**: a `<run-id>-summary.md` file with the publishable headline:
*"NpmGuard detected K/N real-world npm malware events (Datadog corpus,
recall Y% [low%, high%])"*.

### 2. Build the `/benchmark` frontend dashboard

Currently a placeholder ("Coming soon"). After the first full run produces
real numbers, replace it with a real dashboard. Effort: ~1 focused day.

Design notes in
`~/.claude/projects/.../memory/frontend-benchmark-todo.md`:

- Hero recall number with Wilson CI bar
- Per-category table (compromised vs malicious-intent)
- Drill-down to existing `/package/<fixture>` (reuses Wave 1+2 viewer)
- Static `frontend/public/bench-summary.json` populated at deploy time
  (option 1, simpler) OR `GET /bench/summary` engine endpoint (option 2,
  live). Start with option 1.

---

## 🔵 Soon, after bench v1 is published

### 3. GitHub Action for npm-supply-chain audit on PRs

Highest-leverage distribution play. A single `uses: NpmGuard/audit-action@v1`
in any repo's CI runs the auditor on every PR that touches `package-lock.json`,
posts a comment with verdicts + payment links for un-audited packages.
Detailed pitch already discussed; no code yet.

### 4. Mutation testing (bench v2.0)

Per `bench/METHODOLOGY.md` §13 — adds per-attack-class recall and
adversarial sophistication tiers (T1 blatant → T4 evasive) on top of the
Datadog replay. Same runner / analyzer / dashboard, new manifest source.

### 5. Comparative wrappers (bench v1.2)

Wrap `npm audit` and Snyk CLI to ingest the same Datadog corpus, produce a
side-by-side detection table. Free comparative marketing.

---

## 🟣 Backlog (longer term)

- **Content-addressed audits** — commit each report's SHA-256 on Base
  Sepolia so any party can verify the report wasn't tampered with after
  payment. Pairs with the existing download bundle's audit-certificate
  footer.
- **Public read API + webhooks** — let downstream tools (Linear, Slack)
  subscribe to verdict changes for a given package.
- **Native bindings & web-runtime coverage** — current pipeline is
  Node-server-centric; `.node` binaries and Vite/webpack plugins have
  different threat models.
- **Author challenge flow** — let a package author dispute a DANGEROUS
  verdict; capped re-audit for free.

---

## ❌ Explicit no's

- AI chat with the report ("ask the audit") — distracts from the moat.
- VS Code extension — much harder than CLI for marginal reach.
- Multi-provider LLM — one good model is enough for v1.
- Mainnet payment — testnet is fine until there's a real reason.
- Mobile app — web works on mobile.

---

## Operational gotchas (worth keeping in mind)

- **Datadog fixtures contain live malware.** They're `.gitignore`d
  (`sandbox/test-fixtures/test-pkg-bench-dd-*`) and regenerated via
  `datadog:fetch`. Never commit. Never `npm install` them outside the
  bench tooling.
- **Deploy webhook is fragile**: it has failed silently in the past when
  `package-lock.json` was modified locally on the server. Permanent fix
  would replace `git pull` with `git fetch && git reset --hard
  origin/main` in `deploy/pull-and-restart.sh`.
- **`sandbox/` is not a workspace** — its `node_modules` are not populated
  by the root `npm install`. Run `cd sandbox && npm install` once after
  fresh clones.
- **Engine logs go to `/var/log/npmguard.log`**, not `journalctl -u
  npmguard.service`. The systemd unit has `StandardOutput=append:`.
- **Bench audits run on the prod engine** (port 8000) via the CRE
  fire-and-forget bypass + the runner's poll loop. During a 12-17h bench
  run, real users' /audit calls queue behind the bench. Acceptable while
  user volume is low; if it grows, spin up a 2nd engine instance.

---

## Where else this knowledge lives

- `bench/METHODOLOGY.md` — how the benchmark is supposed to work (citable)
- `bench/README.md` — quick operator's guide for the bench
- `~/.claude/projects/-Users-tanguyvans-Desktop-project-NpmGuard/memory/`
  — Claude's persistent memory: bench-status, bench-runbook, engine-fixes,
  frontend-benchmark-todo, prod-droplet
- `CLAUDE.md` (and per-package CLAUDE.md) — project-level instructions
  Claude reads on every session
