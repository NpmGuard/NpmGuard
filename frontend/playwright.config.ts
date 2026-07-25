import { defineConfig } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_STUB_PORT, GITHUB_STUB_URL, seedFixture } from "./e2e/panel-fixture.ts";

/**
 * E2e proves the artifact: real chromium → real vite → the REAL Python engine
 * in its deterministic demo-replay mode (payment off, zero LLM, zero docker).
 * Never a mocked engine — the demo path replays committed recordings through
 * the real HTTP + SSE boundary.
 *
 * The panel is proved the same way and against the same engine: a third server
 * (`tests/support/panel_e2e_server.py`) serves the GitHub App + OAuth stub the
 * Python e2e tier already uses, and the engine gets the five credentials that
 * flip `github_app_enabled`. With them absent every panel route 503s and the
 * dashboard renders its honest "not configured" state — which is why a dashboard
 * spec failing on "element not found" with NO server error is almost always
 * missing `NPMGUARD_GITHUB_*`, not a bad selector.
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
// re-wipe in the worker would run AFTER the seed below and AFTER the engine
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
  // Seeded HERE rather than in a globalSetup, because Playwright starts
  // webServers before globalSetup runs and the panel's verdict index is built
  // from these files once, at engine boot. See panel-fixture.ts.
  seedFixture(E2E_DATA_DIR);
}

const SCENARIO_PATH = join(E2E_DATA_DIR, "github-scenario.json");
const APP_KEY_PATH = join(E2E_DATA_DIR, "app-key.pem");
const DATABASE_URL = `sqlite+aiosqlite:///${join(E2E_DATA_DIR, "e2e.sqlite3")}`;

export default defineConfig({
  testDir: "./e2e",
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
      // The GitHub App + OAuth stub, and the slow-404 npm registry that keeps a
      // cache-MISS dep deterministic. Started as a peer of the engine so the
      // engine can reach it at boot.
      command: `uv run --frozen python -m tests.support.panel_e2e_server --port ${GITHUB_STUB_PORT}`,
      cwd: "../engine",
      url: `${GITHUB_STUB_URL}/fixture/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        NPMGUARD_E2E_SCENARIO: SCENARIO_PATH,
        // Same database the engine opens: the alert fan-out control endpoint
        // calls the engine's own writer against it.
        NPMGUARD_DATABASE_URL: DATABASE_URL,
      },
    },
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
        NPMGUARD_DATABASE_URL: DATABASE_URL,
        NPMGUARD_CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        // Recorded pacing ÷ 20. Fast enough for the gate, slow enough that the
        // mid-stream reload scenario still lands while the stream is live.
        // Prod-identical when unset.
        NPMGUARD_DEMO_SPEED: "20",
        // Every dep a panel scan covers is a seeded cache hit except one
        // deliberate miss, and that miss must never reach the real npm. Pointed
        // at the stub's slow 404 registry: an accidental audit fails fast-ish
        // and offline instead of downloading a tarball from the internet.
        NPMGUARD_NPM_REGISTRY: `${GITHUB_STUB_URL}/registry`,
        // ── the five credentials that turn the panel on ────────────────────
        NPMGUARD_GITHUB_APP_ID: "12345",
        NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH: APP_KEY_PATH,
        NPMGUARD_GITHUB_CLIENT_ID: "Iv1.e2eclient",
        NPMGUARD_GITHUB_CLIENT_SECRET: "e2e-client-secret",
        // 32-byte AES-256-GCM key, hex. Settings enforces the shape only, and
        // nothing here asserts on ciphertext.
        NPMGUARD_ENCRYPTION_KEY: "00".repeat(32),
        // githubkit takes this as its base_url and — because it is not an
        // api.github.com host — resolves the OAuth host to the same origin, so
        // App-JWT, token exchange, OAuth and contents all land on the stub.
        NPMGUARD_GITHUB_API_BASE: GITHUB_STUB_URL,
        // The origin the OAuth callback and the post-sign-in redirect come back
        // to: the APP, not the engine, so the browser ends up on /dashboard with
        // its session cookie on the origin it will make requests from.
        NPMGUARD_PANEL_BASE_URL: `http://localhost:${WEB_PORT}`,
        // ── hermeticity: blank the knobs a developer's engine/.env may set ──
        //
        // `Settings` declares `env_file=(REPO_ROOT/.env, cwd/.env)` and this
        // engine runs with cwd=engine/, so a developer's dotenv IS a config
        // source for anything the block above leaves unset — real Stripe keys
        // and a real chain would silently turn S6's "no payment method is
        // configured" from a proven gate into an accident of whose machine ran
        // it. Real env vars outrank the dotenv, and an empty string is a real
        // env var, which is the same defence `EngineHarness.build_env` applies
        // by stripping inherited NPMGUARD_*. Every panel + payment knob any spec
        // reads is therefore pinned here, present or absent.
        NPMGUARD_STRIPE_SECRET_KEY: "",
        NPMGUARD_STRIPE_WEBHOOK_SECRET: "",
        NPMGUARD_STRIPE_API_BASE: "",
        NPMGUARD_CRE_API_KEY: "",
        NPMGUARD_BASE_SEPOLIA_RPC_URL: "",
        NPMGUARD_BASE_SEPOLIA_CONTRACT: "",
        NPMGUARD_BASE_RPC_URL: "",
        NPMGUARD_BASE_CONTRACT: "",
        NPMGUARD_GITHUB_WEBHOOK_SECRET: "",
        NPMGUARD_GITHUB_RAW_BASE: "",
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
