import { packagePath } from "./utils.js";

export interface CheckoutResponse {
  url: string;
  sessionId: string;
}

export interface CheckoutStatus {
  paid: boolean;
  packageName: string;
  version?: string;
  auditId?: string;
}

export interface StartAuditResponse {
  auditId: string;
  packageName: string;
}

export type Verdict = "SAFE" | "DANGEROUS";

const VERDICTS: readonly string[] = ["SAFE", "DANGEROUS"];

/**
 * Narrow a verdict off the wire, or `null` if it is not one the engine can reach.
 *
 * The domain is closed: an audit concludes SAFE or DANGEROUS, and an audit that
 * cannot conclude is an `audit_error`, never a third verdict. So `null` here is a
 * protocol violation — a stale server, a proxy rewriting the body — and every
 * caller must surface it as one. It is NOT a soft "we're not sure": inventing a
 * middle state is how "we couldn't check" gets rendered as a hedge instead of a
 * failure.
 */
export function asVerdict(value: unknown): Verdict | null {
  const upper = typeof value === "string" ? value.toUpperCase() : "";
  return VERDICTS.includes(upper) ? (upper as Verdict) : null;
}

export interface PackageReport {
  packageName: string;
  version: string;
  verdict: string;
  rationale?: string;
  counts?: Record<string, number>;
  hypotheses?: unknown[];
  confirmedHypIds?: string[];
  [key: string]: unknown;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON but got ${contentType || "unknown content type"}`);
  }
  return res.json() as Promise<T>;
}

export async function checkout(
  apiUrl: string,
  packageName: string,
  version?: string,
): Promise<CheckoutResponse> {
  const body: Record<string, string> = { packageName };
  if (version) body.version = version;

  return request<CheckoutResponse>(`${apiUrl}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function pollCheckoutStatus(
  apiUrl: string,
  sessionId: string,
): Promise<CheckoutStatus> {
  return request<CheckoutStatus>(
    `${apiUrl}/checkout/${encodeURIComponent(sessionId)}/status`,
  );
}

export async function startAudit(
  apiUrl: string,
  stripeSessionId: string,
): Promise<StartAuditResponse> {
  return request<StartAuditResponse>(`${apiUrl}/audit/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stripeSessionId }),
  });
}

export async function startAuditWithTxHash(
  apiUrl: string,
  packageName: string,
  version: string,
  txHash: string,
): Promise<StartAuditResponse> {
  return request<StartAuditResponse>(`${apiUrl}/audit/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageName, version, txHash, chain: "base-sepolia" }),
  });
}

export async function startAuditFree(
  apiUrl: string,
  packageName: string,
  version?: string,
): Promise<StartAuditResponse> {
  return request<StartAuditResponse>(`${apiUrl}/audit/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageName, ...(version && { version }) }),
  });
}

export async function checkoutRaw(
  apiUrl: string,
  packageName: string,
  version?: string,
): Promise<{ status: number; data: CheckoutResponse | null }> {
  const body: Record<string, string> = { packageName };
  if (version) body.version = version;

  const res = await fetch(`${apiUrl}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 501) {
    return { status: 501, data: null };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return { status: res.status, data: (await res.json()) as CheckoutResponse };
}

export async function getPackageReport(
  apiUrl: string,
  packageName: string,
  version?: string,
): Promise<PackageReport | null> {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const url = `${apiUrl}/package/${packagePath(packageName)}/report${query}`;

  try {
    return await request<PackageReport>(url);
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith("HTTP 404") || err.message.startsWith("Expected JSON"))) {
      return null;
    }
    throw err;
  }
}
