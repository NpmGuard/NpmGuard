/**
 * Browser-wallet payment (MetaMask/Rabby via window.ethereum) for the web app.
 * The wallet signs; the ENGINE verifies the receipt — no client-side trust,
 * and no private-key path may ever exist here.
 *
 * The contract address + fee come from GET /config/public (never hardcoded —
 * the engine is the source of truth). There is deliberately no WalletConnect
 * relay path: the CLI owns that flow, and the production CSP blocks relay
 * websockets.
 */

import {
  createWalletClient,
  custom,
  defineChain,
  type Address,
  type EIP1193Provider,
} from "viem";
import type { CryptoConfig } from "./engine-types.ts";

export const AUDIT_REQUEST_ABI = [
  {
    type: "function",
    name: "requestAudit",
    stateMutability: "payable",
    inputs: [
      { name: "packageName", type: "string" },
      { name: "version", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "auditFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function hasInjectedWallet(
  provider: unknown = typeof window !== "undefined" ? window.ethereum : undefined,
): boolean {
  return provider != null;
}

export class WalletRejectedError extends Error {
  constructor() {
    super("Transaction rejected in the wallet");
    this.name = "WalletRejectedError";
  }
}

function isRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("reject") || message.includes("denied");
}

function walletChain(config: CryptoConfig) {
  const nativeSymbol = config.nativeSymbol ?? (config.chain.startsWith("0g") ? "0G" : "ETH");
  return defineChain({
    id: config.chainId,
    name: config.label ?? config.chain,
    nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: 18 },
    rpcUrls: {
      default: {
        http: config.rpcUrl ? [config.rpcUrl] : [],
      },
    },
    blockExplorers: config.explorerUrl
      ? { default: { name: `${config.label ?? config.chain} explorer`, url: config.explorerUrl } }
      : undefined,
  });
}

async function ensureChain(provider: EIP1193Provider, config: CryptoConfig): Promise<void> {
  const chainId = `0x${config.chainId.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: config.label ?? config.chain,
          nativeCurrency: {
            name: config.nativeSymbol ?? (config.chain.startsWith("0g") ? "0G" : "ETH"),
            symbol: config.nativeSymbol ?? (config.chain.startsWith("0g") ? "0G" : "ETH"),
            decimals: 18,
          },
          rpcUrls: config.rpcUrl ? [config.rpcUrl] : [],
          blockExplorerUrls: config.explorerUrl ? [config.explorerUrl] : [],
        },
      ],
    });
  }
}

/**
 * Connect the injected wallet, switch to the engine-selected chain, and sign
 * requestAudit(packageName, version) with the audit fee attached to
 * `contract`. Returns the tx hash — server-side verification happens when the
 * hash is submitted to POST /audit/stream.
 */
export async function payWithInjected(
  config: CryptoConfig,
  packageName: string,
  version: string,
  feeWei: bigint,
  provider: EIP1193Provider | undefined = typeof window !== "undefined" ? window.ethereum : undefined,
): Promise<`0x${string}`> {
  if (!provider) throw new Error("No browser wallet detected");
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
    const account = accounts[0];
    if (!account) throw new Error("No wallet account available");
    await ensureChain(provider, config);
    const client = createWalletClient({ chain: walletChain(config), transport: custom(provider) });
    return await client.writeContract({
      account,
      address: config.contract as Address,
      abi: AUDIT_REQUEST_ABI,
      functionName: "requestAudit",
      args: [packageName, version],
      value: feeWei,
    });
  } catch (err) {
    if (isRejection(err)) throw new WalletRejectedError();
    throw err;
  }
}
