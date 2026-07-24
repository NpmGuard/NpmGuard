import { defineConfig } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * E2e proves the artifact: real chromium → real vite → the REAL Python engine
 * in its deterministic demo-replay mode (payment off, zero LLM, zero docker).
 * Never a mocked engine — the demo path replays committed recordings through
 * the real HTTP + SSE boundary.
 *
 * workers:1, retries:0 — audit sessions and the SSE hub are in-process engine
 * state; parallel runs cross-talk, and a flaky spec is a bug, not a retry.
 */

const ENGINE_PORT = 8055; // never 8000 — don't fight a running dev engine
const WEB_PORT = 3100; // never 3000 — don't fight `npm run dev`

// Hermetic engine state: every run starts from an empty data root so reports,
// sessions, and the sqlite db never leak between runs or into the repo's data/.
const E2E_DATA_DIR = join(import.meta.dirname, ".e2e-data");
// Playwright RE-IMPORTS this config in each test-worker process, so guard the
// destructive wipe to the MAIN process only (workers set TEST_WORKER_INDEX). A
// re-wipe in the worker would run AFTER globalSetup seeded and AFTER the engine
// opened its sqlite here — nuking the seeded reports and the live db mid-run.
if (process.env.TEST_WORKER_INDEX === undefined) {
  rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  // Recreate the empty root immediately so the engine can open its sqlite db
  // here. The engine's own lazy mkdir mis-parses an absolute
  // `sqlite+aiosqlite:////abs` URL (rsplit("///") drops the leading slash → a
  // relative dir), so it never creates this absolute parent; in dev that's
  // masked because data/ pre-exists, but the wipe above removes it. Pre-creating
  // here is the harness-side fix.
  mkdirSync(E2E_DATA_DIR, { recursive: true });
}

export default defineConfig({
  testDir: "./e2e",
  // Seeds durable reports into E2E_DATA_DIR AFTER the wipe above, so /packages
  // and /package/<name> have something to serve (S4/S5). See e2e/global-setup.ts.
  globalSetup: "./e2e/global-setup.ts",
  timeout: 120_000, // demo replay paces events with (÷DEMO_SPEED) delays
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  expect: { timeout: 20_000 },
  webServer: [
    {
      command: `uv run --frozen uvicorn npmguard.api:app --host 127.0.0.1 --port ${ENGINE_PORT}`,
      cwd: "../engine",
      url: `http://localhost:${ENGINE_PORT}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        NPMGUARD_ENV: "dev",
        NPMGUARD_PAYMENT_REQUIRED: "false",
        NPMGUARD_MOCK_LLM: "true", // defense: no path in e2e calls a real provider
        NPMGUARD_DATA_DIR: E2E_DATA_DIR,
        NPMGUARD_AUDIT_LOG_DIR: join(E2E_DATA_DIR, "audit-logs"),
        NPMGUARD_DATABASE_URL: `sqlite+aiosqlite:///${join(E2E_DATA_DIR, "e2e.sqlite3")}`,
        NPMGUARD_CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        // Recorded pacing ÷ 20. Fast enough for the gate, slow enough that the
        // mid-stream reload scenario still lands while the stream is live.
        // Prod-identical when unset.
        NPMGUARD_DEMO_SPEED: "20",
      },
    },
    {
      command: `../node_modules/.bin/vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: { VITE_API_TARGET: `http://localhost:${ENGINE_PORT}` },
    },
  ],
});
