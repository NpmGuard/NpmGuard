// In-memory dedup for on-chain payments. One txHash can trigger one audit.
// For multi-instance deployments, replace with Postgres-backed store.

interface ChainPaymentRecord {
  auditId: string;
  packageName: string;
  version: string;
  requester: string;
  createdAt: number;
}

const payments = new Map<string, ChainPaymentRecord>();

function key(chain: string, txHash: string): string {
  return `${chain}:${txHash.toLowerCase()}`;
}

export function getChainPayment(
  chain: string,
  txHash: string,
): ChainPaymentRecord | undefined {
  return payments.get(key(chain, txHash));
}

export function recordChainPayment(
  chain: string,
  txHash: string,
  record: Omit<ChainPaymentRecord, "createdAt">,
): void {
  payments.set(key(chain, txHash), { ...record, createdAt: Date.now() });
}

export function cleanupOldChainPayments(maxAgeMs = 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [k, v] of payments.entries()) {
    if (v.createdAt < cutoff) payments.delete(k);
  }
}
