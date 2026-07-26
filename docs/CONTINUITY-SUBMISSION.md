# NpmGuard — 0G Continuity submission sheet

Use this as the final pre-submission checklist. It distinguishes implemented
features from values that can only be filled after deployment and recording.

## Project

**Name:** NpmGuard

**Short description:** NpmGuard is an autonomous npm supply-chain security
auditor. In unified 0G mode it runs its full multi-agent audit pipeline through
verified 0G Compute, persists reports and human-publisher evidence on 0G
Storage, accepts audit payments on 0G Chain, and anchors evidence roots in an
append-only 0G Chain registry.

**Public repository:** _add the final public GitHub URL_

**Live demo:** [https://npmguard.com](https://npmguard.com) — update after the
0G-enabled deployment is live.

**Demo video:** _add the final video URL; keep it under three minutes_

## Continuity proof

- Prior independent 0G work:
  [`5b9772be2ace0ab1300437d29e0d8e37d46f1124`](https://github.com/NpmGuard/NpmGuard/commit/5b9772be2ace0ab1300437d29e0d8e37d46f1124)
  (`2026-04-04T19:40:11+02:00`) moved NpmGuard audit settlement to 0G
  Galileo and deployed the earlier contract at
  [`0x1201448ae5f00e1783036439569e71ab3757d0de`](https://chainscan-galileo.0g.ai/address/0x1201448ae5f00e1783036439569e71ab3757d0de).
- Lisbon delta baseline:
  [`67f830f772f876cba053d97b889533dab8475adf`](https://github.com/NpmGuard/NpmGuard/commit/67f830f772f876cba053d97b889533dab8475adf)
  (`2026-07-25T13:27:17+02:00`).
- Dated Lisbon work: [CHANGELOG-LISBON.md](CHANGELOG-LISBON.md).
- Starting point: NpmGuard had independently integrated 0G Compute and Galileo
  settlement in April. The Lisbon baseline had since evolved to the Python
  audit engine, CLI, dashboard, and Base/Stripe payments, but the earlier 0G
  integration was no longer present. Lisbon work restores it on the current
  architecture and adds verified routing, 0G Storage, an append-only registry,
  production readiness, and the publisher continuity product.

## 0G features and SDKs

| 0G feature | Implementation | Proof to show |
|---|---|---|
| Compute Router | OpenAI-compatible Router for every audit role; `verify_tee: true`; verified/private trust routing; latency/price provider sorting; fail-closed `x_0g_trace.tee_verified` check; full trace capture including provider address and exact neuron billing | Run an audit and show `provider = 0g:verified` plus its captured Router trace |
| Storage | Official `0g-storage-sdk` Python client; RFC 8785 canonical reports/evidence; upload by Merkle root; proof-verified download | Show the returned report/evidence root and retrieve it from the configured indexer |
| 0G Chain settlement | `NpmGuardAuditRequest` on Galileo; wallet network switching; server-side receipt/event/package/version verification; exactly-once payment claim | Pay for an audit and open its transaction in Chainscan |
| 0G Chain registry | `NpmGuardAttestations`; engine relayer publishes the artifact digest and Storage root after World/GitHub verification | Attest a release, then show both its Storage root and registry transaction |

One product flag, `NPMGUARD_ZEROG_ENABLED=true`, selects Compute, makes the
configured 0G chain the preferred wallet network, enables report mirroring, and
wires Storage roots into the registry. `/config/public` exposes readiness and a
production process fails at startup rather than silently running a partial 0G
configuration.

## Contract deployments

Do not submit placeholder addresses. Deploy with the commands below, then fill
in both rows and link each address to Chainscan.

| Contract | Network | Address |
|---|---|---|
| `NpmGuardAuditRequest` | 0G Galileo, chain id 16602 | _pending funded deployment_ |
| `NpmGuardAttestations` | 0G Galileo, chain id 16602 | _pending funded deployment_ |

```bash
cd contracts
./deploy.sh 0g-testnet audit
./deploy.sh 0g-testnet attestations
```

Then set `NPMGUARD_ZEROG_TESTNET_CONTRACT` and
`NPMGUARD_ZEROG_ATTESTATIONS_CONTRACT` in the production environment.

## Three-minute demo spine

1. Show `/config/public`: unified mode on, Compute/Storage/attestations ready,
   Galileo preferred.
2. Pay for one audit on Galileo and show the transaction on Chainscan.
3. Run the audit; call out verified 0G Compute and the finished report’s 0G
   Storage publication.
4. Attest one release; show the evidence Storage root and the registry
   transaction returned on the same screen/CLI.
5. End on the install decision: NpmGuard combines sandbox evidence with the
   publisher’s continuity history.

## Team and contacts

Fill these before submission:

| Member | Role | Telegram | X |
|---|---|---|---|
| _name_ | _role_ | _@telegram_ | _@x_ |

## What’s next

Deploy both contracts to Galileo and make the 0G proof handles first-class on
every public report. Next, represent auditor/publisher agents with Agentic ID so
their encrypted state and reputation can move between operators. Evaluate 0G DA
for high-volume audit traces once the project runs the required DA client and
encoder infrastructure; it is not claimed in this submission.
