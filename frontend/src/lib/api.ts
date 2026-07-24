/** One typed function per DEV engine route (engine/npmguard/api.py). */

import { getJson, postJson } from "./api-base.ts";
import { apiBase } from "./config.ts";
import type {
  AuditReport,
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
 * running — only called after verdict_reached / for the durable lookup. */
export function fetchAuditReport(auditId: string): Promise<AuditReport> {
  return getJson(`${apiBase()}/audit/${auditId}/report`, "Could not load the report");
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
 * mounts a splat route. */
export function fetchPackageReport(name: string, version?: string): Promise<PackageReportResponse> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  return getJson(`${apiBase()}/package/${name}/report${query}`, "No audit report found");
}
