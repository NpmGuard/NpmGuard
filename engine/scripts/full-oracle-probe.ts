/**
 * Full-oracle sensor-suite probe.
 *
 * The experimenter now runs EVERY sensor on EVERY experiment (FULL_ORACLE). No
 * unit test exercises all five layers together — phase-a-smoke runs each in
 * isolation — so this probe eyeballs that they COEXIST in a single run: strace
 * (L1) + pcap (L2) + fs-diff (L3) + monkey-patch (L4) + in-process V8 inspector
 * all attached at once, against a known-bad fixture. The question it answers is
 * "does turning every sensor on simultaneously break, race, or starve any of
 * them?" — not "does this fixture happen to exercise each layer."
 *
 * To make the answer fixture-independent it plants a marker file-write during
 * the trigger (so L3 fs-diff has a change to observe) on top of the env/cred
 * bait the experimenter plants for real. What each layer then observes:
 *   L1  syscalls from the run                         (any real Node payload)
 *   L2  DNS/TLS on the wire       — known env race; we require the sensor
 *                                    ATTACHED (pcapHash set), not that it parsed
 *   L3  the planted marker file_created
 *   L4  monkey-patched require/fs/env/net calls
 *   L4  v8inspector script_parsed (Node compiles the CJS wrapper → always fires)
 *
 *   npx tsx engine/scripts/full-oracle-probe.ts [fixture]   # default: test-pkg-env-exfil
 *
 * Requires Docker + the npmguard-sandbox image.
 */

import * as path from "node:path";
import type { ObserveFlags, ToolCall } from "@npmguard/shared";
import { runUnderObservation } from "../src/evidence/run-under-observation.js";
import { renderTimeline } from "../src/evidence/timeline.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES_DIR = path.join(REPO_ROOT, "sandbox", "test-fixtures");

const FULL_ORACLE: ObserveFlags = {
  kernel: true,
  network: true,
  node: true,
  fsDiff: true,
  inspector: true,
};

const PLANTED_TOKEN = "NPMGUARD_CANARY_TOKEN_f8e2d91a";
const MARKER_PATH = "/home/node/.npmguard-oracle-marker";

async function main(): Promise<void> {
  const fixture = process.argv[2] ?? "test-pkg-env-exfil";
  const packagePath = path.join(FIXTURES_DIR, fixture);

  console.log(`\n=== full-oracle probe: ${fixture} ===`);
  console.log(`  package: ${packagePath}`);
  console.log(`  observe: ${JSON.stringify(FULL_ORACLE)}`);

  // Mirrors the env/cred-theft plan the experimenter builds, plus a marker
  // write so L3 fs-diff has an observable change regardless of the fixture.
  const experiment: ToolCall[] = [
    {
      tool: "setEnv",
      args: {
        env: {
          NPM_TOKEN: PLANTED_TOKEN,
          AWS_ACCESS_KEY_ID: "AKIA" + PLANTED_TOKEN.slice(0, 16),
          HOME: "/home/node",
        },
      },
    },
    {
      tool: "plantFiles",
      args: {
        files: [
          {
            path: "/home/node/.npmrc",
            content: `//registry.npmjs.org/:_authToken=${PLANTED_TOKEN}\n`,
          },
        ],
      },
    },
    {
      tool: "preload",
      args: { code: `require('fs').writeFileSync('${MARKER_PATH}', 'coexist');` },
    },
    { tool: "trigger", args: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null } },
  ];

  const artifact = await runUnderObservation({
    packagePath,
    experiment,
    observe: FULL_ORACLE,
    budget: { wallMs: 15_000, maxSyscalls: null, maxBytesCapture: 2_000_000 },
  });

  console.log(`\n  runId:        ${artifact.runId}`);
  console.log(`  contentHash:  ${artifact.contentHash}`);
  console.log(`  wallMs:       ${artifact.wallMs}`);
  console.log(`  exitCode:     ${artifact.exitCode}`);
  console.log(`  timedOut:     ${artifact.timedOut}`);
  console.log(`  error:        ${artifact.error ? `${artifact.error.kind} — ${artifact.error.detail.slice(0, 300)}` : "none"}`);
  console.log(`  events:       ${artifact.events.length}`);

  const byStream = new Map<string, number>();
  for (const ev of artifact.events) {
    byStream.set(ev.stream, (byStream.get(ev.stream) ?? 0) + 1);
  }
  const LAYERS = ["L1:seccomp", "L2:pcap", "L3:fsDiff", "L4:monkey", "L4:v8inspector"];
  console.log(`\n  per-layer coverage:`);
  for (const layer of LAYERS) {
    const n = byStream.get(layer) ?? 0;
    console.log(`    ${n > 0 ? "✓" : "·"} ${layer.padEnd(16)} ${n} event(s)`);
  }

  const byKind = new Map<string, number>();
  for (const ev of artifact.events) {
    byKind.set(ev.kind, (byKind.get(ev.kind) ?? 0) + 1);
  }
  console.log(`\n  event kinds:  ${[...byKind.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  console.log(`  summary:      hosts=[${artifact.eventSummary.uniqueHosts.join(",")}] dns=[${artifact.eventSummary.dnsQueries.join(",")}]`);
  console.log(`  attach hashes: strace=${artifact.straceLogHash ? "set" : "-"} pcap=${artifact.pcapHash ? "set" : "-"} fsDiff=${artifact.fsDiffHash ? "set" : "-"}`);

  const markerSeen = artifact.events.some(
    (e) => e.stream === "L3:fsDiff" && e.kind === "file_created" && String(e.normalized?.path ?? "") === MARKER_PATH,
  );
  const v8WithSource = artifact.events.some(
    (e) => e.stream === "L4:v8inspector" && String(e.normalized?.source ?? "").length > 0,
  );

  const timeline = renderTimeline(artifact);
  console.log(`\n----- TIMELINE (${timeline.text.split("\n").length} lines) -----`);
  console.log(timeline.text);

  // Coexistence checks. A sensor "works alongside the others" if it either
  // produced events or provably attached (raw hash set). L2's parse is the one
  // known environmental race (documented in phase-a-smoke) — we require attach,
  // not events, and report whether events landed.
  const checks: Array<{ ok: boolean; label: string }> = [
    { ok: artifact.error === null, label: "run completed with no error" },
    { ok: (byStream.get("L1:seccomp") ?? 0) > 0 && !!artifact.straceLogHash, label: "L1 strace attached + produced syscalls" },
    { ok: !!artifact.pcapHash, label: "L2 pcap attached (pcapHash set)" },
    { ok: markerSeen && !!artifact.fsDiffHash, label: "L3 fs-diff observed the planted marker" },
    { ok: (byStream.get("L4:monkey") ?? 0) > 0, label: "L4 monkey-patch produced events" },
    { ok: v8WithSource, label: "L4 v8inspector captured decoded source" },
  ];

  console.log(`\n  coexistence checks:`);
  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`    ${c.ok ? "✓" : "✗"} ${c.label}`);
  }
  const l2Events = byStream.get("L2:pcap") ?? 0;
  console.log(`    · L2 pcap parsed ${l2Events} event(s) ${l2Events > 0 ? "" : "(empty — known env race, not a coexistence failure)"}`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(allOk ? "FULL ORACLE PROBE: PASS — all sensors coexist in one run" : "FULL ORACLE PROBE: FAIL");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
