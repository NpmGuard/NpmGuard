/**
 * THE e2e fixture: the durable reports the engine boots with, and the GitHub
 * scenario the stub server serves. One file, because the two halves have to
 * name the same (package, version) pairs — a lockfile dep is a cache HIT only
 * if a report for exactly that pair is on disk, and a scenario where that
 * silently stopped being true would still pass a weaker assertion instead of
 * failing.
 *
 * ── WHY THIS RUNS AT CONFIG LOAD AND NOT IN `globalSetup` ───────────────────
 *
 * A `globalSetup` is fine for the report/registry scenarios: `/packages` and
 * `/package/<name>` read the report files off disk on every request, so seeding
 * them after the engine booted is invisible.
 *
 * The panel does not read disk. Its cache-first scan reads `package_verdicts`,
 * and that index is rebuilt from `data/reports/` ONCE, at engine boot
 * (`api.py`'s `panel_verdicts.rebuild`). Playwright runs webServer plugins
 * BEFORE `globalSetup` (`createGlobalSetupTasks` orders plugin setup first), so
 * a report seeded there lands after the rebuild has already read an empty
 * directory — every dep is a cache miss, every miss runs a real audit, and the
 * scenario decays into "everything errored" while still looking like it ran.
 *
 * Seeding from the config module body is what makes the order unconditional:
 * the wipe, the seed and the scenario write all happen before any server exists.
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEMO_DIR = join(import.meta.dirname, "..", "..", "engine", "demo-data");

/** Where the stub server listens. Exported so the config's `webServer` entry and
 * the specs that call its control plane cannot disagree about the port. */
export const GITHUB_STUB_PORT = 8056;
export const GITHUB_STUB_URL = `http://127.0.0.1:${GITHUB_STUB_PORT}`;

/** The two committed recordings, filed under the PUBLIC names the durable views
 * serve them from. `report_store._public()` filters any package starting
 * "test-pkg-"/"test-package" or containing "-bench-", so the DANGEROUS recording
 * (`test-pkg-env-exfil`) is re-homed. The report body carries no package identity
 * of its own — the API stamps `packageName` from the route — so the rename is
 * faithful.
 *
 * report_store keys the on-disk version off the trace inventory phase's
 * `metadata.version`, falling back to the filename stem: chalk's trace carries
 * "5.6.2"; the exfil trace carries none, so its `2.0.1.json` stem is
 * authoritative. Both agree with the versions below, so `?version=` lookups and
 * the lockfiles here resolve to the exact seeded files. */
export const SAFE_PKG = { name: "chalk", version: "5.6.2" } as const;
export const DANGEROUS_PKG = { name: "npm-telemetry-helper", version: "2.0.1" } as const;

/** A dep with NO seeded report: a real cache miss that fans out a panel job.
 * The stub registry 404s it (slowly — see `registryDelayMs`), so the audit
 * cannot conclude and the dep settles ERROR. Never SAFE, and never a spinner
 * that resolves itself. */
export const MISSING_PKG = { name: "unreachable-dep", version: "9.9.9" } as const;

const SEEDS: ReadonlyArray<{ recording: string; packageName: string; version: string }> = [
  { recording: "chalk.json", packageName: SAFE_PKG.name, version: SAFE_PKG.version },
  {
    recording: "test-pkg-env-exfil.json",
    packageName: DANGEROUS_PKG.name,
    version: DANGEROUS_PKG.version,
  },
];

/** A package-lock v3 whose direct deps are `pkgs` (transitive ones are marked so
 * with `direct: false`). Shaped exactly like the lockfiles the panel's parser
 * reads in production — the `packages[""]` entry is what makes a dep DIRECT. */
function lockfile(pkgs: ReadonlyArray<{ name: string; version: string; direct?: boolean }>): string {
  const dependencies: Record<string, string> = {};
  const packages: Record<string, unknown> = {};
  for (const pkg of pkgs) {
    if (pkg.direct !== false) dependencies[pkg.name] = `^${pkg.version}`;
    packages[`node_modules/${pkg.name}`] = { version: pkg.version };
  }
  return JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies }, ...packages } });
}

/** The signed-in identity and the workspace it can see. Ids are fixed so a spec
 * can address a repo by id without discovering it first. */
export const FIXTURE = {
  oauthCode: "e2e_code",
  userToken: "e2e_user_token",
  user: { id: 4242, login: "octocat", name: "Mona Lisa", email: "mona@example.com" },
  org: "acme",
  installationId: 500,
  /** Long enough that a scan's one cache-MISS dep keeps the set `running` while
   * the browser looks at it, short enough that three attempts (`MAX_ATTEMPTS`)
   * still settle well inside the spec timeout. A racy "did I catch the running
   * state" assertion would be a flaky spec, and a flaky spec is a bug. */
  registryDelayMs: 1_500,
  repos: {
    /** SAFE hit + DANGEROUS hit + one miss → a DANGEROUS rollup that partitions
     * as safe 1 / dangerous 1 / error 1. */
    web: { owner: "acme", name: "web", id: 1001 },
    /** One SAFE hit only → a settled SAFE posture with no jobs at all. */
    api: { owner: "acme", name: "api", id: 1002 },
    /** Never scanned, so Protect has no dep index to watch and must kick the
     * background first scan. Its single dep is a hit, so that scan concludes
     * without touching a registry. */
    docs: { owner: "acme", name: "docs", id: 1003 },
  },
} as const;

/** The scenario the Python stub server applies (`tests/support/panel_e2e_server.py`). */
function scenario() {
  return {
    appSlug: "npmguard",
    appId: 1,
    oauthCode: FIXTURE.oauthCode,
    userToken: FIXTURE.userToken,
    user: FIXTURE.user,
    registryDelayMs: FIXTURE.registryDelayMs,
    installations: [{ id: FIXTURE.installationId, account: FIXTURE.org }],
    repos: [
      {
        ...FIXTURE.repos.web,
        installationId: FIXTURE.installationId,
        lockfile: lockfile([SAFE_PKG, DANGEROUS_PKG, { ...MISSING_PKG, direct: false }]),
      },
      {
        ...FIXTURE.repos.api,
        installationId: FIXTURE.installationId,
        lockfile: lockfile([SAFE_PKG]),
      },
      {
        ...FIXTURE.repos.docs,
        installationId: FIXTURE.installationId,
        lockfile: lockfile([SAFE_PKG]),
      },
    ],
  };
}

/** Seed reports + scenario + App key into `dataDir`; returns the paths the
 * engine and the stub server need in their env. Call ONCE, before any server
 * starts. */
export function seedFixture(dataDir: string): { scenarioPath: string; appKeyPath: string } {
  for (const { recording, packageName, version } of SEEDS) {
    const raw = JSON.parse(readFileSync(join(DEMO_DIR, recording), "utf8")) as { report: unknown };
    if (!raw.report || typeof raw.report !== "object") {
      throw new Error(`Demo recording ${recording} has no usable report to seed`);
    }
    const dir = join(dataDir, "reports", packageName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${version}.json`), JSON.stringify(raw.report, null, 2) + "\n", "utf8");
  }

  const scenarioPath = join(dataDir, "github-scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario(), null, 2) + "\n", "utf8");

  // The App-JWT signing key. Any RSA key works: the stub trusts the Bearer
  // blindly and never verifies a signature, so this is a throwaway generated per
  // run rather than a committed secret — a private key in the repo is a private
  // key someone eventually pastes somewhere real.
  const appKeyPath = join(dataDir, "app-key.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    appKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "utf8",
  );

  return { scenarioPath, appKeyPath };
}
