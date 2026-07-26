import { describe, expect, it } from "vitest";
import type { EIP1193Provider } from "viem";
import type { CryptoConfig } from "./engine-types.ts";
import { payWithInjected } from "./wallet.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}` as `0x${string}`;

function provider() {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const value = {
    async request(input: { method: string; params?: unknown }) {
      requests.push(input);
      if (input.method === "eth_requestAccounts") return [ACCOUNT];
      if (input.method === "wallet_switchEthereumChain") return null;
      if (input.method === "eth_chainId") return "0x40da";
      if (input.method === "eth_sendTransaction") return TX;
      throw new Error(`unexpected wallet method ${input.method}`);
    },
  } as unknown as EIP1193Provider;
  return { value, requests };
}

describe("chain-aware injected payments", () => {
  it("switches to Galileo and submits the configured contract there", async () => {
    const chain: CryptoConfig = {
      chain: "0g-testnet",
      chainId: 16602,
      contract: CONTRACT,
      auditFeeWei: "7",
      label: "0G Galileo Testnet",
      nativeSymbol: "0G",
      rpcUrl: "https://evmrpc-testnet.0g.ai",
      explorerUrl: "https://chainscan-galileo.0g.ai",
    };
    const wallet = provider();

    expect(await payWithInjected(chain, "left-pad", "1.3.0", 7n, wallet.value)).toBe(TX);
    expect(wallet.requests[1]).toEqual({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x40da" }],
    });
    const send = wallet.requests.find((request) => request.method === "eth_sendTransaction");
    expect(send).toBeDefined();
    expect(JSON.stringify(send?.params)).toContain(CONTRACT);
  });
});
