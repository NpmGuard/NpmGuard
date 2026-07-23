import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { SupportedChain } from "./chain.js";

const CERTIFICATE_REGISTRY_ABI = [
  {
    type: "function",
    name: "publishCertificateBatch",
    inputs: [
      { name: "merkleRoot", type: "bytes32" },
      { name: "batchURI", type: "string" },
      { name: "policyVersion", type: "string" },
    ],
    outputs: [{ name: "batchId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "CertificateBatchPublished",
    inputs: [
      { name: "batchId", type: "uint256", indexed: true },
      { name: "merkleRoot", type: "bytes32", indexed: true },
      { name: "batchURI", type: "string", indexed: false },
      { name: "policyVersion", type: "string", indexed: false },
      { name: "publisher", type: "address", indexed: true },
      { name: "createdAt", type: "uint64", indexed: false },
    ],
    anonymous: false,
  },
] as const;

interface CertificateAnchorChainConfig {
  chain: SupportedChain;
  contractAddress: `0x${string}`;
  rpcUrl: string;
  client: PublicClient;
  viemChain: typeof baseSepolia | typeof base;
}

export interface PublishedCertificateBatch {
  chain: SupportedChain;
  contractAddress: `0x${string}`;
  batchId: string;
  transactionHash: Hex;
  blockNumber: string;
}

function normalizePrivateKey(value: string): Hex {
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Certificate publisher private key must be 32 bytes");
  }
  return key as Hex;
}

function readPublisherPrivateKey(): Hex {
  const key =
    process.env.NPMGUARD_CERTIFICATE_PUBLISHER_PRIVATE_KEY ??
    process.env.NPMGUARD_CHAIN_PUBLISHER_PRIVATE_KEY ??
    process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "Missing NPMGUARD_CERTIFICATE_PUBLISHER_PRIVATE_KEY, NPMGUARD_CHAIN_PUBLISHER_PRIVATE_KEY, or DEPLOYER_PRIVATE_KEY",
    );
  }
  return normalizePrivateKey(key);
}

function readCertificateAnchorConfig(
  chain: SupportedChain,
): CertificateAnchorChainConfig {
  if (chain === "base-sepolia") {
    const contractAddress =
      process.env.NPMGUARD_CERTIFICATE_REGISTRY_BASE_SEPOLIA_CONTRACT ??
      process.env.NPMGUARD_BASE_SEPOLIA_CONTRACT;
    if (!contractAddress) {
      throw new Error(
        "Missing NPMGUARD_CERTIFICATE_REGISTRY_BASE_SEPOLIA_CONTRACT or NPMGUARD_BASE_SEPOLIA_CONTRACT",
      );
    }
    const rpcUrl =
      process.env.NPMGUARD_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
    return {
      chain,
      contractAddress: contractAddress as `0x${string}`,
      rpcUrl,
      viemChain: baseSepolia,
      client: createPublicClient({
        chain: baseSepolia,
        transport: http(rpcUrl),
      }) as PublicClient,
    };
  }

  const contractAddress =
    process.env.NPMGUARD_CERTIFICATE_REGISTRY_BASE_CONTRACT ??
    process.env.NPMGUARD_BASE_CONTRACT;
  if (!contractAddress) {
    throw new Error(
      "Missing NPMGUARD_CERTIFICATE_REGISTRY_BASE_CONTRACT or NPMGUARD_BASE_CONTRACT",
    );
  }
  const rpcUrl =
    process.env.NPMGUARD_BASE_RPC_URL ?? "https://mainnet.base.org";
  return {
    chain,
    contractAddress: contractAddress as `0x${string}`,
    rpcUrl,
    viemChain: base,
    client: createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    }) as PublicClient,
  };
}

export function getCertificateRegistryAddress(
  chain: SupportedChain,
): `0x${string}` {
  return readCertificateAnchorConfig(chain).contractAddress;
}

export async function publishCertificateBatchRoot(options: {
  chain: SupportedChain;
  merkleRoot: Hex;
  batchURI: string;
  policyVersion: string;
}): Promise<PublishedCertificateBatch> {
  const cfg = readCertificateAnchorConfig(options.chain);
  const account = privateKeyToAccount(readPublisherPrivateKey());
  const walletClient = createWalletClient({
    account,
    chain: cfg.viemChain,
    transport: http(cfg.rpcUrl),
  });

  const hash = await walletClient.writeContract({
    address: cfg.contractAddress,
    abi: CERTIFICATE_REGISTRY_ABI,
    functionName: "publishCertificateBatch",
    args: [options.merkleRoot, options.batchURI, options.policyVersion],
  });

  const receipt = await cfg.client.waitForTransactionReceipt({
    hash,
    timeout: 60_000,
    pollingInterval: 2_000,
    confirmations: 1,
  });

  if (receipt.status !== "success") {
    throw new Error(`publishCertificateBatch transaction reverted: ${hash}`);
  }

  let batchId: string | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.contractAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: CERTIFICATE_REGISTRY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "CertificateBatchPublished") continue;
      batchId = (decoded.args as { batchId: bigint }).batchId.toString();
      break;
    } catch {
      // Skip unrelated logs.
    }
  }

  if (!batchId) {
    throw new Error(
      `Could not find CertificateBatchPublished event in tx ${hash}`,
    );
  }

  return {
    chain: options.chain,
    contractAddress: cfg.contractAddress,
    batchId,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
  };
}
