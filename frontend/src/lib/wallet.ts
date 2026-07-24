import { SignClient } from "@walletconnect/sign-client";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  AUDIT_REQUEST_ABI,
  BASE_SEPOLIA_CHAIN_ID,
} from "./contract";

const WALLETCONNECT_PROJECT_ID =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ??
  "d5eb170c427570e15ac00ae53acc93ba";

const BASE_SEPOLIA_HEX = "0x14a34"; // 84532

export interface PayResult {
  txHash: Hex;
  sender: string;
}

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;
}

// ---------------------------------------------------------------------------
// MetaMask / injected path
// ---------------------------------------------------------------------------

async function ensureBaseSepolia(ethereum: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}): Promise<void> {
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_SEPOLIA_HEX }],
    });
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 4902) {
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BASE_SEPOLIA_HEX,
            chainName: "Base Sepolia",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://sepolia.base.org"],
            blockExplorerUrls: ["https://sepolia.basescan.org"],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

export async function payWithInjected(
  packageName: string,
  version: string,
  feeWei: bigint,
  contractAddress: Address,
): Promise<PayResult> {
  const ethereum = (window as unknown as {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }).ethereum;
  if (!ethereum) throw new Error("No injected wallet found");

  const accounts = (await ethereum.request({
    method: "eth_requestAccounts",
  })) as string[];
  const sender = accounts[0];
  if (!sender) throw new Error("No account approved");

  await ensureBaseSepolia(ethereum);

  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: custom(ethereum),
    account: sender as `0x${string}`,
  });

  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: AUDIT_REQUEST_ABI,
    functionName: "requestAudit",
    args: [packageName, version],
    value: feeWei,
  });

  return { txHash, sender };
}

// ---------------------------------------------------------------------------
// WalletConnect path
// ---------------------------------------------------------------------------

export interface WalletConnectHandle {
  uri: string;
  result: Promise<PayResult>;
  cancel: () => void;
}

export async function startWalletConnectPayment(
  packageName: string,
  version: string,
  feeWei: bigint,
  contractAddress: Address,
): Promise<WalletConnectHandle> {
  const calldata = encodeFunctionData({
    abi: AUDIT_REQUEST_ABI,
    functionName: "requestAudit",
    args: [packageName, version],
  });

  const signClient = await SignClient.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: "NpmGuard",
      description: "NPM package security audit",
      url: window.location.origin,
      icons: [],
    },
  });

  const { uri, approval } = await signClient.connect({
    requiredNamespaces: {
      eip155: {
        methods: ["eth_sendTransaction"],
        chains: [`eip155:${BASE_SEPOLIA_CHAIN_ID}`],
        events: ["chainChanged", "accountsChanged"],
      },
    },
  });

  if (!uri) throw new Error("Failed to generate WalletConnect URI");

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };

  const result: Promise<PayResult> = (async () => {
    const session = await approval();
    if (cancelled) throw new Error("Cancelled");

    const accounts = session.namespaces.eip155?.accounts ?? [];
    const baseAccount = accounts.find((a: string) =>
      a.startsWith(`eip155:${BASE_SEPOLIA_CHAIN_ID}:`),
    );
    const sender = baseAccount
      ? baseAccount.split(":")[2]
      : accounts[0]?.split(":")[2];
    if (!sender) throw new Error("Wallet did not approve any accounts");

    const txHash = (await signClient.request({
      topic: session.topic,
      chainId: `eip155:${BASE_SEPOLIA_CHAIN_ID}`,
      request: {
        method: "eth_sendTransaction",
        params: [
          {
            from: sender,
            to: contractAddress,
            data: calldata,
            value: "0x" + feeWei.toString(16),
          },
        ],
      },
    })) as Hex;

    return { txHash, sender };
  })();

  return { uri, result, cancel };
}
