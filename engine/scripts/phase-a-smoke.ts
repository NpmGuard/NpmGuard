/**
 * Phase A end-to-end smoke script.
 *
 * Exercises `runUnderObservation` against known-bad fixtures from
 * `sandbox/test-fixtures/` and prints what came back. Expands sprint-by-sprint:
 *   - Sprint 2: entrypoint runs + L4 monkey-patch capture
 *   - Sprint 3: manipulation primitives (env, plantFiles, stubUrl, setDate, ...)
 *   - Sprint 4: L1/L2/L3 sensors
 *   - Sprint 5: V8 Inspector correlation
 *
 * Run with:
 *   npx tsx engine/scripts/phase-a-smoke.ts             # run all cases
 *   npx tsx engine/scripts/phase-a-smoke.ts <filter>    # subset by name/fixture
 *
 * Requires Docker daemon running and the configured sandbox image available.
 */

import * as path from "node:path";
import type { RunArtifact } from "@npmguard/shared";
import { runUnderObservation } from "../src/evidence/run-under-observation.js";
import type { RunRequest } from "../src/evidence/run-under-observation.js";
import {
  setEnv,
  setDate,
  plantFiles,
  stubUrl,
  preload,
} from "../src/manipulation/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES_DIR = path.join(REPO_ROOT, "sandbox", "test-fixtures");

type Expectation = (artifact: RunArtifact) => { ok: boolean; why?: string };

interface Case {
  name: string;
  sprint: number;
  req: Omit<RunRequest, "packagePath"> & { fixture: string };
  expect: Expectation;
}

const CASES: Case[] = [
  // ── Sprint 2 baseline ────────────────────────────────────────────────────
  {
    name: "sprint-2: test-pkg-env-exfil via L4 (no setup)",
    sprint: 2,
    req: {
      fixture: "test-pkg-env-exfil",
      trigger: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null },
      budget: { wallMs: 15_000, maxSyscalls: null, maxBytesCapture: 1_000_000 },
      observe: { node: true, kernel: false, network: false, fsDiff: false, inspector: false },
    },
    expect: (a) => {
      const l4 = a.events.filter((e) => e.stream === "L4:monkey");
      return l4.length > 0
        ? { ok: true }
        : { ok: false, why: "expected L4 events" };
    },
  },

  // ── Sprint 4a: L3 fs-diff sensor ────────────────────────────────────────
  {
    name: "sprint-4a: fsDiff observes files the trigger creates",
    sprint: 4,
    req: {
      fixture: "test-pkg-env-exfil",
      trigger: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null },
      budget: { wallMs: 15_000, maxSyscalls: null, maxBytesCapture: 1_000_000 },
      observe: { node: true, kernel: false, network: false, fsDiff: true, inspector: false },
      // Preload writes a marker during the trigger — AFTER fs-diff pre-snapshot —
      // so the sensor should report it as file_created.
      setup: [
        preload(
          `require('fs').writeFileSync('/home/node/.npmguard-evidence-marker', 'created-during-trigger');`,
        ),
      ],
    },
    expect: (a) => {
      const l3 = a.events.filter((e) => e.stream === "L3:fsDiff");
      if (l3.length === 0) return { ok: false, why: "expected at least one L3:fsDiff event" };
      const created = l3.find(
        (e) => e.kind === "file_created" && e.normalized?.path === "/home/node/.npmguard-evidence-marker",
      );
      if (!created) return { ok: false, why: "expected file_created for the marker" };
      if (!a.fsDiffHash) return { ok: false, why: "expected fsDiffHash to be set when there are changes" };
      return { ok: true };
    },
  },

  // ── Sprint 3: all manipulation primitives together ──────────────────────
  {
    name: "sprint-3: env-exfil with setEnv + plantFiles + stubUrl + setDate",
    sprint: 3,
    req: {
      fixture: "test-pkg-env-exfil",
      trigger: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null },
      budget: { wallMs: 15_000, maxSyscalls: null, maxBytesCapture: 1_000_000 },
      observe: { node: true, kernel: false, network: false, fsDiff: false, inspector: false },
      setup: [
        setEnv({
          NPM_TOKEN: "npm_FAKE_TOKEN_A1B2C3D4",
          GITHUB_TOKEN: "ghp_FAKE_xyz",
          AWS_ACCESS_KEY_ID: "AKIAFAKE",
          CI: "true",
        }),
        setDate("2027-03-01T00:00:00Z"),
        plantFiles([
          { path: "/home/node/.npmrc", content: "//registry.npmjs.org/:_authToken=npm_FAKE\n" },
          { path: "/home/node/.ssh/id_rsa", content: "-----BEGIN RSA PRIVATE KEY-----\nFAKE\n" },
          { path: "/home/node/.aws/credentials", content: "[default]\naws_access_key_id=FAKE\n" },
        ]),
        stubUrl([
          { pattern: "*localhost:9999/*", responseStatus: 200, responseBody: "ok" },
        ]),
      ],
    },
    expect: (a) => {
      // Assert manipulation was recorded.
      if (Object.keys(a.setupApplied.env).length !== 4) {
        return { ok: false, why: `expected 4 env vars in setupApplied, got ${Object.keys(a.setupApplied.env).length}` };
      }
      if (a.setupApplied.plantFiles.length !== 3) {
        return { ok: false, why: `expected 3 plantFiles, got ${a.setupApplied.plantFiles.length}` };
      }
      if (a.setupApplied.stubUrls.length !== 1) {
        return { ok: false, why: "expected 1 stubUrl" };
      }
      if (a.setupApplied.date !== "2027-03-01T00:00:00Z") {
        return { ok: false, why: `expected date=2027-03-01T00:00:00Z, got ${a.setupApplied.date}` };
      }
      // Assert L4 observed env access + network attempt.
      const envEvents = a.events.filter((e) => e.kind === "env_access");
      const netEvents = a.events.filter((e) => e.kind === "network");
      if (envEvents.length === 0) return { ok: false, why: "expected env_access events" };
      if (netEvents.length === 0) return { ok: false, why: "expected network events" };
      return { ok: true };
    },
  },
];

async function runCase(c: Case): Promise<boolean> {
  const packagePath = path.join(FIXTURES_DIR, c.req.fixture);
  console.log(`\n=== [sprint ${c.sprint}] ${c.name} ===`);
  console.log(`  package: ${packagePath}`);
  console.log(`  trigger: ${c.req.trigger.kind} -> ${c.req.trigger.target}`);

  const { fixture: _fixture, ...reqRest } = c.req;
  void _fixture;

  const artifact = await runUnderObservation({ ...reqRest, packagePath });

  console.log(`  runId:        ${artifact.runId}`);
  console.log(`  contentHash:  ${artifact.contentHash}`);
  console.log(`  wallMs:       ${artifact.wallMs}`);
  console.log(`  exitCode:     ${artifact.exitCode}`);
  console.log(`  timedOut:     ${artifact.timedOut}`);
  console.log(`  error:        ${artifact.error ? `${artifact.error.kind} — ${artifact.error.detail.slice(0, 200)}` : "none"}`);
  console.log(`  events:       ${artifact.events.length}`);
  console.log(`  summary:      hosts=[${artifact.eventSummary.uniqueHosts.join(",")}] dns=[${artifact.eventSummary.dnsQueries.join(",")}]`);

  const byKind = new Map<string, number>();
  for (const ev of artifact.events) {
    byKind.set(ev.kind, (byKind.get(ev.kind) ?? 0) + 1);
  }
  console.log(`  event kinds:  ${[...byKind.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`);

  console.log(`  setupApplied: env=${Object.keys(artifact.setupApplied.env).length} plantFiles=${artifact.setupApplied.plantFiles.length} stubUrls=${artifact.setupApplied.stubUrls.length} patches=${artifact.setupApplied.patches.length} date=${artifact.setupApplied.date ?? "-"}`);

  const result = c.expect(artifact);
  console.log(`  status:       ${result.ok ? "PASS" : `FAIL — ${result.why ?? "unknown"}`}`);
  return result.ok;
}

async function main(): Promise<void> {
  const filter = process.argv[2];
  const cases = filter
    ? CASES.filter((c) => c.name.includes(filter) || c.req.fixture.includes(filter))
    : CASES;

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
