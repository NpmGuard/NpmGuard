/**
 * Playwright globalSetup — seed durable reports into the hermetic engine data
 * dir so the report/registry scenarios (S4/S5) have something to read.
 *
 * WHY this exists: playwright.config.ts wipes E2E_DATA_DIR at config-load, so
 * the engine boots with an EMPTY reports/ dir — /packages is empty and every
 * /package/<name> 404s. This runs AFTER config-load (so the wipe already
 * happened) and writes a couple of schemaVersion-2 reports straight to disk,
 * exactly where the engine's report_store reads them:
 *     <E2E_DATA_DIR>/reports/<pkg>/<version>.json
 * The report bodies are lifted verbatim from the committed demo recordings'
 * `report` field — the SAME artifact the demo replay finalizes — so the durable
 * view renders identical structure to the live one, with zero new fixtures.
 *
 * Seeded under PUBLIC names: report_store._public() filters out any package
 * starting with "test-pkg-"/"test-package" or containing "-bench-", so the
 * DANGEROUS recording (test-pkg-env-exfil) is re-homed under "npm-telemetry-
 * helper" to make it visible in the registry. The report body carries no
 * package identity of its own (the API stamps packageName from the route), so a
 * rename is faithful.
 *
 * report_store keys the on-disk version off the trace inventory phase's
 * metadata.version, falling back to the filename stem — chalk's trace carries
 * "5.6.2"; the exfil trace carries none, so its 2.0.1.json stem is authoritative.
 * Both align with the filenames below, so the registry version column and the
 * ?version= lookups resolve to the exact seeded files.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mirror the path playwright.config.ts computes (its dir is frontend/, this
// file is frontend/e2e/, so climb one level to the same .e2e-data root).
const REPORTS_DIR = join(import.meta.dirname, "..", ".e2e-data", "reports");
const DEMO_DIR = join(import.meta.dirname, "..", "..", "engine", "demo-data");

/** Recording file → the PUBLIC (packageName, version) the report is durably
 * filed under. */
const SEEDS: ReadonlyArray<{ recording: string; packageName: string; version: string }> = [
  // SAFE, kept under its real public name.
  { recording: "chalk.json", packageName: "chalk", version: "5.6.2" },
  // DANGEROUS. The recording's own name starts "test-pkg-" (filtered from the
  // registry), so re-home it under a public name to exercise S4/S5.
  { recording: "test-pkg-env-exfil.json", packageName: "npm-telemetry-helper", version: "2.0.1" },
];

export default function globalSetup(): void {
  for (const { recording, packageName, version } of SEEDS) {
    const raw = JSON.parse(readFileSync(join(DEMO_DIR, recording), "utf8")) as {
      report: unknown;
    };
    if (!raw.report || typeof raw.report !== "object") {
      throw new Error(`Demo recording ${recording} has no usable report to seed`);
    }
    const dir = join(REPORTS_DIR, packageName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${version}.json`),
      JSON.stringify(raw.report, null, 2) + "\n",
      "utf8",
    );
  }
}
