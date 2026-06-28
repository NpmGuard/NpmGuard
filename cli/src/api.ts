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

export interface PackageReport {
  packageName: string;
  version: string;
  verdict: string;
  score?: number;
  findings?: unknown[];
  [key: string]: unknown;
}

export interface PublicConfig {
  paymentRequired: boolean;
  paymentEnabled: boolean;
  stripeEnabled: boolean;
  priceCents: number;
  crypto: {
    chain: "base-sepolia";
    chainId: 84532;
    contract: string;
    auditFeeWei: string | null;
  } | null;
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

export async function getPublicConfig(apiUrl: string): Promise<PublicConfig> {
  return request<PublicConfig>(`${apiUrl}/config/public`);
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
  const url = `${apiUrl}/package/${encodeURIComponent(packageName)}/report${query}`;

  try {
    return await request<PackageReport>(url);
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith("HTTP 404") || err.message.startsWith("Expected JSON"))) {
      return null;
    }
    throw err;
  }
}
