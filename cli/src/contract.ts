// NpmGuardAuditRequest — the same contract on every supported chain.
// Deploy script: contracts/deploy.sh
// Source: contracts/src/NpmGuardAuditRequest.sol

import { defineChain, type Chain } from "viem";

export const AUDIT_REQUEST_ADDRESS_BASE_SEPOLIA =
  "0xBF562626e4Afb883423Ec719e0270DB232bcB9eD" as `0x${string}`;

// Base mainnet — not deployed yet
export const AUDIT_REQUEST_ADDRESS_BASE = "0x" as `0x${string}`;

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_CHAIN_ID = 8453;

/**
 * A settlement chain the CLI can pay on. `name` is the engine's chain name and
 * is what goes back to `POST /audit/stream`, so these strings must match
 * `engine/npmguard/payments.py::CHAINS` exactly.
 *
 * Chains are defined here rather than imported from `viem/chains` so that
 * support for a chain never depends on which release of viem is installed.
 */
export interface ChainDef {
  name: string;
  label: string;
  chainId: number;
  explorer: string;
  /** Fallback address, used only when the engine does not report one. */
  address?: `0x${string}`;
  chain: Chain;
}

function evm(
  id: number,
  name: string,
  symbol: string,
  rpc: string,
  explorer: string,
): Chain {
  return defineChain({
    id,
    name,
    nativeCurrency: { name: symbol, symbol, decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name, url: explorer } },
  });
}

// 0G chain ids verified against the live RPCs (eth_chainId → 0x40da / 0x4115).
// Galileo is 16602; most third-party sources still report a stale 16601.
export const CHAINS: Record<string, ChainDef> = {
  "base-sepolia": {
    name: "base-sepolia",
    label: "Base Sepolia",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    explorer: "https://sepolia.basescan.org",
    address: AUDIT_REQUEST_ADDRESS_BASE_SEPOLIA,
    chain: evm(
      BASE_SEPOLIA_CHAIN_ID,
      "Base Sepolia",
      "ETH",
      "https://sepolia.base.org",
      "https://sepolia.basescan.org",
    ),
  },
  base: {
    name: "base",
    label: "Base",
    chainId: BASE_CHAIN_ID,
    explorer: "https://basescan.org",
    chain: evm(
      BASE_CHAIN_ID,
      "Base",
      "ETH",
      "https://mainnet.base.org",
      "https://basescan.org",
    ),
  },
  "0g-testnet": {
    name: "0g-testnet",
    label: "0G Galileo Testnet",
    chainId: 16602,
    explorer: "https://chainscan-galileo.0g.ai",
    chain: evm(
      16602,
      "0G Galileo Testnet",
      "0G",
      "https://evmrpc-testnet.0g.ai",
      "https://chainscan-galileo.0g.ai",
    ),
  },
  "0g": {
    name: "0g",
    label: "0G Aristotle",
    chainId: 16661,
    explorer: "https://chainscan.0g.ai",
    chain: evm(
      16661,
      "0G Aristotle",
      "0G",
      "https://evmrpc.0g.ai",
      "https://chainscan.0g.ai",
    ),
  },
};

/** A chain the engine reported as configured, resolved against the table above. */
export interface ChainTarget extends ChainDef {
  address: `0x${string}`;
}

export function resolveChain(
  name: string,
  address?: string | null,
): ChainTarget | null {
  const def = CHAINS[name];
  if (!def) return null;
  // The engine's address wins: it is the deployment the engine will actually
  // verify receipts against, so trusting a stale bundled constant over it would
  // send a real payment to a contract the engine ignores.
  const resolved = (address ?? def.address) as `0x${string}` | undefined;
  if (!resolved || resolved === "0x") return null;
  return { ...def, address: resolved };
}

export const AUDIT_REQUEST_ABI = [
  {
    type: "constructor",
    inputs: [{ name: "_auditFee", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "requestAudit",
    inputs: [
      { name: "packageName", type: "string" },
      { name: "version", type: "string" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "isRequested",
    inputs: [
      { name: "packageName", type: "string" },
      { name: "version", type: "string" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "auditFee",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
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
] as const;
