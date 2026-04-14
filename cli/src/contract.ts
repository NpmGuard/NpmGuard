// NpmGuardAuditRequest — deployed on Base Sepolia
// Deploy script: contracts/deploy.sh
// Source: contracts/src/NpmGuardAuditRequest.sol

export const AUDIT_REQUEST_ADDRESS_BASE_SEPOLIA =
  "0xBF562626e4Afb883423Ec719e0270DB232bcB9eD" as `0x${string}`;

// Base mainnet — not deployed yet
export const AUDIT_REQUEST_ADDRESS_BASE = "0x" as `0x${string}`;

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_CHAIN_ID = 8453;

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
