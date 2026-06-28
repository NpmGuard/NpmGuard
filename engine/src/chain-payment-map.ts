import * as fs from "node:fs";
import * as path from "node:path";

// Disk-backed dedup for on-chain payments. One txHash can trigger one audit.
// For multi-instance deployments, replace with Postgres-backed store.

interface ChainPaymentRecord {
  auditId: string;
  packageName: string;
  version: string;
  requester: string;
  createdAt: number;
}

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const STORE_PATH = path.join(DATA_DIR, "chain-payments.json");
const payments = new Map<string, ChainPaymentRecord>();

function isRecord(value: unknown): value is ChainPaymentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ChainPaymentRecord>;
  return (
    typeof record.auditId === "string" &&
    typeof record.packageName === "string" &&
    typeof record.version === "string" &&
    typeof record.requester === "string" &&
    typeof record.createdAt === "number"
  );
}

function loadPayments(): void {
  if (!fs.existsSync(STORE_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return;
    for (const [k, v] of Object.entries(raw)) {
      if (isRecord(v)) payments.set(k, v);
    }
  } catch (err) {
    console.warn(
      "[chain-payment-map] failed to load store:",
      err instanceof Error ? err.message : err,
    );
  }
}

function savePayments(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const obj = Object.fromEntries(payments.entries());
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

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
  savePayments();
}

export function cleanupOldChainPayments(maxAgeMs = 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;
  for (const [k, v] of payments.entries()) {
    if (v.createdAt < cutoff) {
      payments.delete(k);
      changed = true;
    }
  }
  if (changed) savePayments();
}

loadPayments();
