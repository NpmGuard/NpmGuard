// NpmGuardAuditRequest — deployed on Base Sepolia
// Keep in sync with cli/src/contract.ts

export const AUDIT_REQUEST_ADDRESS_BASE_SEPOLIA =
  "0xBF562626e4Afb883423Ec719e0270DB232bcB9eD" as `0x${string}`;

export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const AUDIT_REQUEST_ABI = [
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
    name: "auditFee",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;
