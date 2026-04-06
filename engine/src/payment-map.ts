interface PaymentRecord {
  auditId: string;
  packageName: string;
  version: string;
  timestamp: number;
}

const sessionPaymentMap = new Map<string, PaymentRecord>();

const TTL_MS = 2 * 60 * 60_000; // 2 hours

export function recordPayment(
  sessionId: string,
  auditId: string,
  packageName: string,
  version: string,
): void {
  sessionPaymentMap.set(sessionId, {
    auditId,
    packageName,
    version,
    timestamp: Date.now(),
  });
}

export function getPayment(sessionId: string): PaymentRecord | undefined {
  return sessionPaymentMap.get(sessionId);
}

export function cleanupOldPayments(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, record] of sessionPaymentMap) {
    if (record.timestamp < cutoff) {
      sessionPaymentMap.delete(id);
    }
  }
}
