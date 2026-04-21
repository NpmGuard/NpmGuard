/**
 * Phase A end-to-end smoke script.
 *
 * Exercises `runUnderObservation` against known-bad fixtures from
 * `sandbox/test-fixtures/` and prints what came back. Expands sprint-by-sprint:
 *   - Sprint 2: entrypoint runs + L4 monkey-patch capture
 *   - Sprint 3: manipulation primitives (env, plantFiles, stubUrl, ...)
 *   - Sprint 4: L1/L2/L3 sensors
 *   - Sprint 5: V8 Inspector correlation
 *
 * Run with: `npx tsx engine/scripts/phase-a-smoke.ts [fixture-name]`
 * Requires Docker daemon running and the configured sandbox image available.
 */

import * as path from "node:path";
import { runUnderObservation } from "../src/evidence/run-under-observation.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES_DIR = path.join(REPO_ROOT, "sandbox", "test-fixtures");

interface Case {
  name: string;
  fixture: string;
  entrypoint: string;
  expect: (events: unknown[]) => boolean;
}

const SPRINT_2_CASES: Case[] = [
  {
    name: "test-pkg-env-exfil via L4",
    fixture: "test-pkg-env-exfil",
    entrypoint: "setup.js",
    expect: (events) => events.length > 0,
  },
];

async function runCase(c: Case): Promise<boolean> {
  const packagePath = path.join(FIXTURES_DIR, c.fixture);
  console.log(`\n=== ${c.name} ===`);
  console.log(`  package: ${packagePath}`);
  console.log(`  trigger: entrypoint -> ${c.entrypoint}`);

  const artifact = await runUnderObservation({
    packagePath,
    trigger: { kind: "entrypoint", target: c.entrypoint, argv: [], stdin: null },
    budget: { wallMs: 15_000, maxSyscalls: null, maxBytesCapture: 1_000_000 },
    observe: { node: true, kernel: false, network: false, fsDiff: false, inspector: false },
  });

  console.log(`  runId:        ${artifact.runId}`);
  console.log(`  contentHash:  ${artifact.contentHash}`);
  console.log(`  wallMs:       ${artifact.wallMs}`);
  console.log(`  exitCode:     ${artifact.exitCode}`);
  console.log(`  timedOut:     ${artifact.timedOut}`);
  console.log(`  error:        ${artifact.error ? `${artifact.error.kind} — ${artifact.error.detail.slice(0, 200)}` : "none"}`);
  console.log(`  events:       ${artifact.events.length}`);
  console.log(`  summary:      hosts=[${artifact.eventSummary.uniqueHosts.join(",")}] syscalls=[${artifact.eventSummary.uniqueSyscalls.join(",")}] dns=[${artifact.eventSummary.dnsQueries.join(",")}]`);

  const byKind = new Map<string, number>();
  for (const ev of artifact.events) {
    byKind.set(ev.kind, (byKind.get(ev.kind) ?? 0) + 1);
  }
  console.log(`  event kinds:  ${[...byKind.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`);

  const ok = c.expect(artifact.events);
  console.log(`  status:       ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

async function main(): Promise<void> {
  const filter = process.argv[2];
  const cases = filter
    ? SPRINT_2_CASES.filter((c) => c.name.includes(filter) || c.fixture.includes(filter))
    : SPRINT_2_CASES;

  if (cases.length === 0) {
    console.error(`no cases match "${filter}"`);
    process.exit(1);
  }

  let allOk = true;
  for (const c of cases) {
    try {
      const ok = await runCase(c);
      if (!ok) allOk = false;
    } catch (err) {
      console.error(`  status:       ERROR — ${err instanceof Error ? err.message : String(err)}`);
      allOk = false;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(allOk ? "PHASE A SMOKE: PASS" : "PHASE A SMOKE: FAIL");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
