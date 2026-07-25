/** One typed function per DEV engine route (engine/npmguard/api.py). */

import { AuditReportSchema, type AuditReport } from "@npmguard/shared";
import { getJson, postJson } from "./api-base.ts";
import { apiBase } from "./config.ts";
import { ContractViolationError, getWire, parseWire } from "./wire.ts";
import type {
  CheckoutResponse,
  CheckoutStatus,
  PackageReportResponse,
  PackageSummary,
  PublicConfig,
  ResolveResponse,
  StartAuditResponse,
} from "./engine-types.ts";

export function fetchPublicConfig(): Promise<PublicConfig> {
  return getJson(`${apiBase()}/config/public`, "Could not load configuration");
}

/** Resolve a dist-tag ("latest") to a concrete semver. The engine rejects
 * non-semver versions on /audit/stream, so resolve first. `name` may be scoped
 * (@scope/pkg) — the splat route keeps the slash unencoded. */
export function resolveVersion(name: string, version?: string): Promise<ResolveResponse> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  return getJson(`${apiBase()}/resolve/${name}${query}`, "Could not resolve the package version");
}

export type StartAuditPayload =
  | { packageName: string; version?: string } // dev mode (payment off)
  | { stripeSessionId: string }
  | { packageName: string; version: string; txHash: string; chain: "base-sepolia" | "base" };

/** POST /audit/stream — idempotent per payment proof (replays return the same
 * auditId). */
export function startAuditStream(payload: StartAuditPayload): Promise<StartAuditResponse> {
  return postJson(`${apiBase()}/audit/stream`, payload, "Could not start the audit");
}

export function startDemo(packageName: string): Promise<StartAuditResponse> {
  return postJson(`${apiBase()}/demo/start`, { packageName }, "Could not start the demo");
}

export function fetchDemoPackages(): Promise<{ packages: string[] }> {
  return getJson(`${apiBase()}/demo/packages`, "Could not load demo packages");
}

export function startCheckout(
  packageName: string,
  version?: string,
  email?: string,
): Promise<CheckoutResponse> {
  return postJson(
    `${apiBase()}/checkout`,
    { packageName, version, email },
    "Could not start checkout",
  );
}

export function fetchCheckoutStatus(sessionId: string): Promise<CheckoutStatus> {
  return getJson(`${apiBase()}/checkout/${sessionId}/status`, "Could not read the checkout status");
}

/** 200 report once terminal. The engine answers 202 {status} while still
 * running — only called after verdict_reached / for the durable lookup.
 *
 * PARSED, not cast: the report is the largest structure the app receives and it
 * drives the entire report view, so a dropped engine field would otherwise reach
 * a component as `undefined` (a missing `counts` renders an empty rail; a
 * retired `verdict` picks no tone at all). A violation throws
 * ContractViolationError, which `query-client.ts` classifies as terminal — drift
 * is deterministic and must not be retried. */
export function fetchAuditReport(auditId: string): Promise<AuditReport> {
  return getWire(
    `${apiBase()}/audit/${auditId}/report`,
    AuditReportSchema,
    `GET /audit/${auditId}/report`,
  );
}

export async function fetchAuditFile(
  auditId: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  // `path` is a splat segment — leave it unencoded (the engine denies traversal
  // server-side).
  const res = await fetch(`${apiBase()}/audit/${auditId}/file/${path}`, { signal });
  if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
  return res.text();
}

export function fetchPackages(): Promise<{ packages: PackageSummary[] }> {
  return getJson(`${apiBase()}/packages`, "Could not load audited packages");
}

/** `name` may be scoped (@scope/pkg) — the slash stays unencoded, the engine
 * mounts a splat route.
 *
 * The envelope has no schema in `@npmguard/shared` (see `engine-types.ts`), so it
 * is checked structurally while the part that carries structure — the report — is
 * delegated to `AuditReportSchema`. That split is deliberate rather than lazy:
 * the report is where a drifted engine field actually corrupts a view, and it is
 * the half a hand-written check could get wrong. The two envelope strings only
 * label the page.
 * TODO(contract): author this envelope in `shared/src/backend.ts` and delete the
 * structural half. */
export async function fetchPackageReport(
  name: string,
  version?: string,
): Promise<PackageReportResponse> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const what = `GET /package/${name}/report`;
  const raw = await getJson<unknown>(`${apiBase()}/package/${name}/report${query}`, "No audit report found");
  const envelope = (raw ?? {}) as Record<string, unknown>;
  const report = parseWire(AuditReportSchema, envelope["report"], `${what} (report)`);
  const { packageName, version: reportedVersion } = envelope;
  if (typeof packageName !== "string" || typeof reportedVersion !== "string") {
    throw new ContractViolationError(what, "packageName, version: expected string", raw);
  }
  return { report, version: reportedVersion, packageName };
}
