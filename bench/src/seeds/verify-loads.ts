import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SEEDS } from "./catalog.js";
import type { Seed } from "../types.js";

// ---------------------------------------------------------------------------
// verify-loads — for every fetched seed, attempt to load it from a child
// process and record the result. METHODOLOGY.md §7 requires that every
// seed (and later, every mutated seed) loads cleanly under `require()`
// before being included in the benchmark run, so the auditor receives a
// behaviour signal rather than a load-time error.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const SEEDS_DIR = join(BENCH_ROOT, "dataset", "seeds");

const LOAD_TIMEOUT_MS = 8_000;

interface LoadOutcome {
  seed: string;
  status: "ok" | "skipped" | "failed";
  message: string;
}

function seedDirName(seed: Seed): string {
  return `${seed.name.replace(/\//g, "__")}-${seed.version}`;
}

/** Try `require(seedDir)` in a clean child node process. We use an
 *  inline `-e` script rather than spawning the seed directly so the seed
 *  can't side-effect this verifier (e.g. process.exit). */
function attemptLoad(seedDir: string): { ok: boolean; reason: string } {
  const code = `
    try {
      require(${JSON.stringify(seedDir)});
      console.log('LOAD_OK');
    } catch (err) {
      console.log('LOAD_FAIL:' + (err && err.message ? err.message : String(err)));
    }
  `;
  try {
    const stdout = execFileSync("node", ["-e", code], {
      timeout: LOAD_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: "pipe",
    });
    if (stdout.includes("LOAD_OK")) return { ok: true, reason: "loaded successfully" };
    const failLine = stdout.split("\n").find((l) => l.startsWith("LOAD_FAIL:"));
    return { ok: false, reason: failLine ? failLine.slice("LOAD_FAIL:".length) : stdout.slice(0, 200) };
  } catch (err) {
    const e = err as { message?: string; signal?: string; killed?: boolean; stdout?: string };
    if (e.signal === "SIGTERM" || e.killed) {
      return { ok: false, reason: `timed out after ${LOAD_TIMEOUT_MS}ms` };
    }
    return {
      ok: false,
      reason: (e.stdout?.toString() || e.message || "unknown spawn error").slice(0, 200),
    };
  }
}

async function main(): Promise<void> {
  const outcomes: LoadOutcome[] = [];

  for (const seed of SEEDS) {
    const seedDir = join(SEEDS_DIR, seedDirName(seed));
    const label = `${seed.name}@${seed.version}`;

    if (!existsSync(seedDir)) {
      outcomes.push({ seed: label, status: "skipped", message: "not fetched" });
      console.log(`[verify-loads]  - ${label}: skipped (run \`npm run -w @npmguard/bench fetch\` first)`);
      continue;
    }

    // Native bindings often refuse to load on machines that lack the
    // build toolchain. We mark them ok-by-construction at this stage —
    // their static-only inclusion is documented in METHODOLOGY.md §12.
    if (seed.form === "native-binding") {
      outcomes.push({
        seed: label,
        status: "ok",
        message: "native-binding (skipped runtime load, static-only)",
      });
      console.log(`[verify-loads]  ◐ ${label}: native-binding (static-only)`);
      continue;
    }

    const { ok, reason } = attemptLoad(seedDir);
    outcomes.push({ seed: label, status: ok ? "ok" : "failed", message: reason });
    console.log(`[verify-loads]  ${ok ? "✓" : "✗"} ${label}: ${reason}`);
  }

  const ok = outcomes.filter((o) => o.status === "ok").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;

  console.log(
    `\n[verify-loads] summary — ${ok} ok, ${failed} failed, ${skipped} skipped (out of ${outcomes.length})`,
  );

  if (failed > 0) {
    console.log("[verify-loads] failures:");
    for (const o of outcomes.filter((x) => x.status === "failed")) {
      console.log(`  ✗ ${o.seed}: ${o.message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[verify-loads] unexpected failure:", err);
  process.exit(2);
});
