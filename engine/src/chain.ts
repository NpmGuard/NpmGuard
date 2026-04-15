import {
  createPublicClient,
  http,
  decodeEventLog,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { baseSepolia, base } from "viem/chains";

const AUDIT_REQUEST_ABI = [
  {
    type: "event",
    name: "AuditRequested",
    inputs: [
      { name: "packageName", type: "string", indexed: false },
      { name: "version", type: "string", indexed: false },
      { name: "requester", type: "address", indexed: true },
      { name: "feePaid", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "auditFee",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export type SupportedChain = "base-sepolia" | "base";

interface ChainConfig {
  contractAddress: `0x${string}`;
  explorerBase: string;
  client: PublicClient;
}

function makeConfig(): Record<SupportedChain, ChainConfig | null> {
  const sepoliaAddr = process.env.NPMGUARD_BASE_SEPOLIA_CONTRACT as
    | `0x${string}`
    | undefined;
  const mainnetAddr = process.env.NPMGUARD_BASE_CONTRACT as
    | `0x${string}`
    | undefined;

  const sepoliaRpc =
    process.env.NPMGUARD_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  const mainnetRpc =
    process.env.NPMGUARD_BASE_RPC_URL ?? "https://mainnet.base.org";

  return {
    "base-sepolia": sepoliaAddr
      ? {
          contractAddress: sepoliaAddr,
          explorerBase: "https://sepolia.basescan.org",
          client: createPublicClient({
            chain: baseSepolia,
            transport: http(sepoliaRpc),
          }) as PublicClient,
        }
      : null,
    base: mainnetAddr
      ? {
          contractAddress: mainnetAddr,
          explorerBase: "https://basescan.org",
          client: createPublicClient({
            chain: base,
            transport: http(mainnetRpc),
          }) as PublicClient,
        }
      : null,
  };
}

let cachedConfig: Record<SupportedChain, ChainConfig | null> | null = null;
function getConfig(): Record<SupportedChain, ChainConfig | null> {
  if (!cachedConfig) cachedConfig = makeConfig();
  return cachedConfig;
}

export interface VerifiedPayment {
  packageName: string;
  version: string;
  requester: `0x${string}`;
  feePaid: bigint;
  blockNumber: bigint;
  explorerUrl: string;
}

export class ChainVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainVerificationError";
  }
}

/**
 * Verify that a txHash on the given chain contains a valid AuditRequested
 * event matching the requested (packageName, version) and was sent to our
 * audit contract. Throws ChainVerificationError on any mismatch.
 */
export async function verifyAuditPayment(
  chain: SupportedChain,
  txHash: Hex,
  expectedPackageName: string,
  expectedVersion: string,
): Promise<VerifiedPayment> {
  const cfg = getConfig()[chain];
  if (!cfg) {
    throw new ChainVerificationError(
      `Chain ${chain} is not configured (missing contract address)`,
    );
  }

  // Use waitForTransactionReceipt rather than getTransactionReceipt — the
  // CLI's public RPC node confirms blocks fractionally before our Alchemy
  // node sees them, so a bare getTransactionReceipt often returns
  // "not found" on fresh transactions. Polling with a short timeout lets us
  // catch up to the chain tip without rejecting legit payments.
  let receipt;
  try {
    receipt = await cfg.client.waitForTransactionReceipt({
      hash: txHash,
      timeout: 30_000,
      pollingInterval: 2_000,
      confirmations: 1,
    });
  } catch (err) {
    throw new ChainVerificationError(
      `Could not fetch receipt for ${txHash}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (receipt.status !== "success") {
    throw new ChainVerificationError(`Transaction ${txHash} reverted`);
  }

  const contractLogs = receipt.logs.filter(
    (log: Log) => log.address.toLowerCase() === cfg.contractAddress.toLowerCase(),
  );

  if (contractLogs.length === 0) {
    throw new ChainVerificationError(
      `Transaction ${txHash} did not interact with audit contract ${cfg.contractAddress}`,
    );
  }

  let match: {
    packageName: string;
    version: string;
    requester: `0x${string}`;
    feePaid: bigint;
  } | null = null;

  for (const log of contractLogs) {
    try {
      const decoded = decodeEventLog({
        abi: AUDIT_REQUEST_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "AuditRequested") continue;
      const args = decoded.args as {
        packageName: string;
        version: string;
        requester: `0x${string}`;
        feePaid: bigint;
      };
      if (
        args.packageName === expectedPackageName &&
        args.version === expectedVersion
      ) {
        match = args;
        break;
      }
    } catch {
      // Not our event, skip
    }
  }

  if (!match) {
    throw new ChainVerificationError(
      `No matching AuditRequested(${expectedPackageName}, ${expectedVersion}) event in tx ${txHash}`,
    );
  }

  return {
    packageName: match.packageName,
    version: match.version,
    requester: match.requester,
    feePaid: match.feePaid,
    blockNumber: receipt.blockNumber,
    explorerUrl: `${cfg.explorerBase}/tx/${txHash}`,
  };
}

export function isChainConfigured(chain: SupportedChain): boolean {
  return getConfig()[chain] !== null;
}

export function getChainContractAddress(chain: SupportedChain): `0x${string}` | null {
  return getConfig()[chain]?.contractAddress ?? null;
}

export async function readAuditFee(chain: SupportedChain): Promise<bigint | null> {
  const cfg = getConfig()[chain];
  if (!cfg) return null;
  return (await cfg.client.readContract({
    address: cfg.contractAddress,
    abi: AUDIT_REQUEST_ABI,
    functionName: "auditFee",
  })) as bigint;
}
