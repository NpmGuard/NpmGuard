/** One typed function per DEV engine route (engine/npmguard/api.py). */

import {
  AuditReportSchema,
  CheckoutResponseSchema,
  CheckoutStatusSchema,
  DemoPackagesResponseSchema,
  PackageIndexResponseSchema,
  PackageReportResponseSchema,
  PublicConfigSchema,
  ResolveResponseSchema,
  StartAuditResponseSchema,
  type AuditReport,
  type CheckoutResponse,
  type CheckoutStatus,
  type DemoPackagesResponse,
  type PackageIndexResponse,
  type PackageReportResponse,
  type PublicConfig,
  type ResolveResponse,
  type StartAuditResponse,
} from "@npmguard/shared";
import { apiBase } from "./config.ts";
import { getWire, postWire } from "./wire.ts";

export function fetchPublicConfig(): Promise<PublicConfig> {
  return getWire(`${apiBase()}/config/public`, PublicConfigSchema, "GET /config/public");
}

/** Resolve a dist-tag ("latest") to a concrete semver. The engine rejects
 * non-semver versions on /audit/stream, so resolve first. `name` may be scoped
 * (@scope/pkg) — the splat route keeps the slash unencoded. */
export function resolveVersion(name: string, version?: string): Promise<ResolveResponse> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  return getWire(
    `${apiBase()}/resolve/${name}${query}`,
    ResolveResponseSchema,
    `GET /resolve/${name}`,
  );
}

export type StartAuditPayload =
  | { packageName: string; version?: string } // dev mode (payment off)
  | { stripeSessionId: string }
  | { packageName: string; version: string; txHash: string; chain: "base-sepolia" | "base" };

/** POST /audit/stream — idempotent per payment proof (replays return the same
 * auditId). */
export function startAuditStream(payload: StartAuditPayload): Promise<StartAuditResponse> {
  return postWire(
    `${apiBase()}/audit/stream`,
    StartAuditResponseSchema,
    "POST /audit/stream",
    payload,
    "Could not start the audit",
  );
}

export function startDemo(packageName: string): Promise<StartAuditResponse> {
  return postWire(
    `${apiBase()}/demo/start`,
    StartAuditResponseSchema,
    "POST /demo/start",
    { packageName },
    "Could not start the demo",
  );
}

export function fetchDemoPackages(): Promise<DemoPackagesResponse> {
  return getWire(
    `${apiBase()}/demo/packages`,
    DemoPackagesResponseSchema,
    "GET /demo/packages",
  );
}

export function startCheckout(
  packageName: string,
  version?: string,
  email?: string,
): Promise<CheckoutResponse> {
  return postWire(
    `${apiBase()}/checkout`,
    CheckoutResponseSchema,
    "POST /checkout",
    { packageName, version, email },
    "Could not start checkout",
  );
}

export function fetchCheckoutStatus(sessionId: string): Promise<CheckoutStatus> {
  return getWire(
    `${apiBase()}/checkout/${sessionId}/status`,
    CheckoutStatusSchema,
    `GET /checkout/${sessionId}/status`,
  );
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

export function fetchPackages(): Promise<PackageIndexResponse> {
  return getWire(`${apiBase()}/packages`, PackageIndexResponseSchema, "GET /packages");
}

/** `name` may be scoped (@scope/pkg) — the slash stays unencoded, the engine
 * mounts a splat route.
 *
 * The whole envelope is parsed, report included. This used to be a hand-written
 * structural check around a delegated `AuditReportSchema` parse, because the
 * envelope had no schema; it now has one, so there is nothing left to hand-check. */
export function fetchPackageReport(
  name: string,
  version?: string,
): Promise<PackageReportResponse> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  return getWire(
    `${apiBase()}/package/${name}/report${query}`,
    PackageReportResponseSchema,
    `GET /package/${name}/report`,
  );
}
