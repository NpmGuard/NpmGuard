/**
 * Shared e2e helpers. Latency bounds are named, generous constants — they gate
 * on conditions (expect auto-retry), never load-bearing sleeps. Demo package
 * names are DISCOVERED from the engine so the suite stays name-agnostic, then
 * mapped to the two committed verdict classes.
 */

import { expect, type APIRequestContext } from "@playwright/test";

/** A demo replay + report hydration is sub-2s at DEMO_SPEED=20; this is the
 * generous ceiling for reaching a terminal verdict across page-load + connect. */
export const TERMINAL_MS = 60_000;

/** The two committed recordings, by verdict class (engine/demo-data/*.json).
 * chalk → SAFE; test-pkg-env-exfil → DANGEROUS. Discovered-and-asserted below,
 * never trusted blind. */
export const SAFE_DEMO = "chalk";
export const DANGEROUS_DEMO = "test-pkg-env-exfil";

/** The PUBLIC names the DANGEROUS/SAFE reports are seeded under for the durable
 * report + registry views (see global-setup.ts). test-pkg-* is filtered from
 * the registry, so the DANGEROUS report is re-homed under a public name. */
export const SAFE_PKG = { name: "chalk", version: "5.6.2" };
export const DANGEROUS_PKG = { name: "npm-telemetry-helper", version: "2.0.1" };

/** GET /demo/packages through the vite proxy → the engine. Asserts the two
 * recordings this suite relies on are actually offered. */
export async function discoverDemoPackages(request: APIRequestContext): Promise<string[]> {
  const res = await request.get("/api/demo/packages");
  expect(res.ok(), "GET /demo/packages should 200").toBeTruthy();
  const { packages } = (await res.json()) as { packages: string[] };
  expect(packages, "both committed recordings must be offered").toEqual(
    expect.arrayContaining([SAFE_DEMO, DANGEROUS_DEMO]),
  );
  return packages;
}

/** POST /demo/start → the auditId for a shareable /audit/:id resume (S3). */
export async function startDemoViaApi(
  request: APIRequestContext,
  packageName: string,
): Promise<string> {
  const res = await request.post("/api/demo/start", { data: { packageName } });
  expect(res.ok(), `POST /demo/start ${packageName} should 200`).toBeTruthy();
  const { auditId } = (await res.json()) as { auditId: string };
  expect(auditId, "demo start must return an auditId").toBeTruthy();
  return auditId;
}
