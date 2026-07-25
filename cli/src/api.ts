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
  // 4-state graph verdict: SAFE | SUSPECT | DANGEROUS | UNKNOWN. Only DANGEROUS blocks.
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
  chain: string,
): Promise<StartAuditResponse> {
  return request<StartAuditResponse>(`${apiUrl}/audit/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageName, version, txHash, chain }),
  });
}

export interface ChainOption {
  chain: string;
  chainId: number;
  contract: string | null;
  auditFeeWei: string | null;
}

export interface PublicConfig {
  paymentRequired: boolean;
  stripeEnabled: boolean;
  priceCents: number;
  /** Every chain the engine has a contract configured for. */
  chains?: ChainOption[];
  /** Pre-multichain shape: the first configured chain, or null. */
  crypto: ChainOption | null;
}

export async function getPublicConfig(apiUrl: string): Promise<PublicConfig> {
  return request<PublicConfig>(`${apiUrl}/config/public`);
}

/**
 * The chains the engine will actually verify a receipt on. Falls back to the
 * legacy single-chain `crypto` field so a new CLI still works against an engine
 * that predates the multichain response.
 */
export function chainOptions(config: PublicConfig): ChainOption[] {
  if (config.chains?.length) return config.chains;
  return config.crypto ? [config.crypto] : [];
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

// --- publisher attestation ---------------------------------------------------

export interface AttestSession {
  sessionId: string;
  packageName: string;
  version: string;
  status: "created" | "owned" | "verified" | "failed";
  githubLogin: string | null;
  error: string | null;
  url?: string;
  integrity?: string;
  attestation?: {
    tier: number;
    nullifier: string;
    environment: string;
    assertions: Record<string, boolean>;
    storageRoot: string | null;
    chainTx: string | null;
    attestedAt: string;
  };
}

export async function openAttestSession(
  apiUrl: string,
  packageName: string,
  version: string,
): Promise<AttestSession> {
  return request<AttestSession>(`${apiUrl}/attest/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageName, version }),
  });
}

export async function getAttestSession(
  apiUrl: string,
  sessionId: string,
): Promise<AttestSession> {
  return request<AttestSession>(`${apiUrl}/attest/session/${sessionId}`);
}
