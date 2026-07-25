import chalk from "chalk";
import ora from "ora";
import qrcode from "qrcode-terminal";
import { SignClient } from "@walletconnect/sign-client";
import { createPublicClient, http, encodeFunctionData, type Hex } from "viem";
import { AUDIT_REQUEST_ABI, type ChainTarget } from "../contract.js";

const WALLETCONNECT_PROJECT_ID =
  process.env.WALLETCONNECT_PROJECT_ID ?? "d5eb170c427570e15ac00ae53acc93ba";

function generateQrCode(text: string): Promise<void> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (code: string) => {
      console.log(code);
      resolve();
    });
  });
}

export interface WalletConnectResult {
  paid: boolean;
  txHash?: Hex;
  sender?: string;
}

export async function payViaWalletConnect(
  packageName: string,
  version: string,
  feeWei: bigint,
  feeDisplay: string,
  target: ChainTarget,
): Promise<WalletConnectResult> {
  const calldata = encodeFunctionData({
    abi: AUDIT_REQUEST_ABI,
    functionName: "requestAudit",
    args: [packageName, version],
  });

  const publicClient = createPublicClient({
    chain: target.chain,
    transport: http(),
  });

  let signClient: Awaited<ReturnType<typeof SignClient.init>> | null = null;

  // WalletConnect throws late "No matching key" errors when sessions clean up
  const wcErrorHandler = (err: Error): void => {
    if (err?.message?.includes("No matching key")) return;
    console.error(err);
    process.exit(1);
  };
  process.on("uncaughtException", wcErrorHandler);

  try {
    const initSpinner = ora("  Connecting to WalletConnect...").start();
    signClient = await SignClient.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: {
        name: "NpmGuard",
        description: "NPM package security audit",
        url: "https://npmguard.com",
        icons: [],
      },
    });
    initSpinner.stop();

    const { uri, approval } = await signClient.connect({
      requiredNamespaces: {
        eip155: {
          methods: ["eth_sendTransaction"],
          chains: [`eip155:${target.chainId}`],
          events: ["chainChanged", "accountsChanged"],
        },
      },
    });

    if (!uri) {
      console.log(chalk.red("  Failed to generate WalletConnect URI"));
      return { paid: false };
    }

    console.log();
    console.log(chalk.cyan("  Scan with your wallet to connect:"));
    console.log();
    await generateQrCode(uri);
    console.log();

    const pairSpinner = ora("  Waiting for wallet connection...").start();
    const session = await approval();

    const accounts = session.namespaces.eip155?.accounts ?? [];
    const baseAccount = accounts.find((a: string) =>
      a.startsWith(`eip155:${target.chainId}:`),
    );
    const sender = baseAccount
      ? baseAccount.split(":")[2]
      : accounts[0]?.split(":")[2];

    if (!sender) {
      pairSpinner.fail("Wallet did not approve any accounts");
      return { paid: false };
    }

    pairSpinner.succeed(
      `Connected: ${sender.slice(0, 6)}...${sender.slice(-4)}`,
    );

    console.log(
      chalk.cyan(
        `  Confirm the ${feeDisplay} transaction in your wallet (${target.label})...`,
      ),
    );

    const txHash = (await signClient.request({
      topic: session.topic,
      chainId: `eip155:${target.chainId}`,
      request: {
        method: "eth_sendTransaction",
        params: [
          {
            from: sender,
            to: target.address,
            data: calldata,
            value: "0x" + feeWei.toString(16),
          },
        ],
      },
    })) as Hex;

    const confirmSpinner = ora("  Waiting for on-chain confirmation...").start();
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status === "success") {
      confirmSpinner.succeed("Payment confirmed on-chain");
      console.log(
        chalk.gray(`  Tx: ${target.explorer}/tx/${txHash}`),
      );
      console.log();
      return { paid: true, txHash, sender };
    }

    confirmSpinner.fail("Transaction reverted");
    return { paid: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("rejected") || msg.includes("denied")) {
      console.log(chalk.yellow("  Transaction rejected by user."));
    } else {
      console.log(chalk.red(`  WalletConnect error: ${msg}`));
    }
    console.log();
    return { paid: false };
  } finally {
    signClient = null;
    setTimeout(() => process.off("uncaughtException", wcErrorHandler), 5000);
  }
}

export async function readAuditFee(target: ChainTarget): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: target.chain,
    transport: http(),
  });
  return (await publicClient.readContract({
    address: target.address,
    abi: AUDIT_REQUEST_ABI,
    functionName: "auditFee",
  })) as bigint;
}
