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

import { createWalletClient, custom, type Address, type EIP1193Provider } from "viem";
import { baseSepolia } from "viem/chains";

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

const CHAIN_ID_HEX = "0x14a34"; // 84532, Base Sepolia

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

async function ensureBaseSepolia(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_ID_HEX,
          chainName: "Base Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://sepolia.base.org"],
          blockExplorerUrls: ["https://sepolia.basescan.org"],
        },
      ],
    });
  }
}

/**
 * Connect the injected wallet, switch to Base Sepolia, and sign
 * requestAudit(packageName, version) with the audit fee attached to
 * `contract`. Returns the tx hash — server-side verification happens when the
 * hash is submitted to POST /audit/stream.
 */
export async function payWithInjected(
  contract: Address,
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
    await ensureBaseSepolia(provider);
    const client = createWalletClient({ chain: baseSepolia, transport: custom(provider) });
    return await client.writeContract({
      account,
      address: contract,
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
