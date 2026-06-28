import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { labelhash, namehash, normalize, packetToBytes } from "viem/ens";

const TEXT_RECORD_PREFIX = "npmguard";
type EnsAccount = ReturnType<typeof privateKeyToAccount>;

const DEFAULT_SEPOLIA_ENS = {
  registry: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
  nameWrapper: "0x0635513f179D50A207757E05759CbD106d7dFcE8",
  publicResolver: "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5",
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  v2Registry: "0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67",
} as const;

const ensRegistryAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "owner",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "resolver",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setResolver",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setSubnodeRecord",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "label", type: "bytes32" },
      { name: "owner", type: "address" },
      { name: "resolver", type: "address" },
      { name: "ttl", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

const publicResolverAbi = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "multicall",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setText",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
] as const;

const nameWrapperAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "getData",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "fuses", type: "uint32" },
      { name: "expiry", type: "uint64" },
    ],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setResolver",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setSubnodeRecord",
    inputs: [
      { name: "parentNode", type: "bytes32" },
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "resolver", type: "address" },
      { name: "ttl", type: "uint64" },
      { name: "fuses", type: "uint32" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ name: "node", type: "bytes32" }],
  },
] as const;

const universalResolverAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "findResolver",
    inputs: [{ name: "name", type: "bytes" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "resolver", type: "address" },
          { name: "node", type: "bytes32" },
          { name: "offset", type: "uint256" },
        ],
      },
    ],
  },
] as const;

const v2RegistryAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "getState",
    inputs: [{ name: "anyId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "expiry", type: "uint64" },
          { name: "latestOwner", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "resource", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "ownerOf",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setResolver",
    inputs: [
      { name: "anyId", type: "uint256" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
] as const;

export interface EnsPublishConfig {
  rpcUrl: string;
  privateKey: string;
  rootDomain: string;
  registryVersion?: "auto" | "v1" | "v2";
  registryAddress?: string;
  nameWrapperAddress?: string;
  publicResolverAddress?: string;
  universalResolverAddress?: string;
  v2RegistryAddress?: string;
}

export interface EnsAuditRecordInput {
  packageName: string;
  version: string;
  verdict: string;
  riskScore: number;
  capabilities: string[];
  publishedAt: string;
  reportCid: string;
  reportUri: string;
  tarballCid?: string;
  tarballUri?: string;
  sourceCid?: string;
  sourceUri?: string;
  sourcePath?: string;
  fileIndexCid?: string;
  fileIndexUri?: string;
  manifestCid: string;
  manifestUri: string;
}

export interface EnsPublishResult {
  parentName: string;
  versionName: string;
  registryVersion: "v1" | "v2";
  recordName: string;
  resolverAddress: Address;
  txHashes: {
    createParentSubname: Hex | null;
    createVersionSubname: Hex | null;
    writeVersionRecords: Hex;
    writeLatestRecords: Hex;
  };
}

interface EnsAddresses {
  registry: Address;
  nameWrapper: Address;
  publicResolver: Address;
  universalResolver: Address;
  v2Registry: Address;
}

interface NameStatus {
  name: string;
  node: Hex;
  owner: Address;
  resolver: Address;
  wrapped: boolean;
  wrappedOwner: Address | null;
  expiry: number | null;
}

interface V2NameStatus {
  name: string;
  label: string;
  anyId: bigint;
  node: Hex;
  status: number;
  owner: Address;
  latestOwner: Address;
  tokenId: bigint;
  resolver: Address;
  expiry: number | null;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function toPrivateKeyHex(privateKey: string): Hex {
  return (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
}

function toAddress(value: string): Address {
  return getAddress(value);
}

function createEnsAddresses(config: EnsPublishConfig): EnsAddresses {
  return {
    registry: toAddress(config.registryAddress ?? DEFAULT_SEPOLIA_ENS.registry),
    nameWrapper: toAddress(config.nameWrapperAddress ?? DEFAULT_SEPOLIA_ENS.nameWrapper),
    publicResolver: toAddress(config.publicResolverAddress ?? DEFAULT_SEPOLIA_ENS.publicResolver),
    universalResolver: toAddress(config.universalResolverAddress ?? DEFAULT_SEPOLIA_ENS.universalResolver),
    v2Registry: toAddress(config.v2RegistryAddress ?? DEFAULT_SEPOLIA_ENS.v2Registry),
  };
}

function createEnsClients(config: EnsPublishConfig) {
  const account = privateKeyToAccount(toPrivateKeyHex(config.privateKey));
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(config.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(config.rpcUrl),
  });

  return {
    account,
    publicClient,
    walletClient,
    addresses: createEnsAddresses(config),
  };
}

export function ensSafeLabel(value: string): string {
  const label = value
    .replace(/^@/, "")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!label) {
    throw new Error(`Cannot derive an ENS label from "${value}"`);
  }
  return label.slice(0, 63);
}

export function versionToEnsLabel(version: string): string {
  return ensSafeLabel(version || "latest");
}

export function packageToParentEnsName(packageName: string, rootDomain: string): string {
  return `${ensSafeLabel(packageName)}.${normalize(rootDomain)}`;
}

function versionToEnsName(parentName: string, version: string): string {
  return `${versionToEnsLabel(version)}.${parentName}`;
}

function splitName(name: string): { label: string; parentName: string; normalizedName: string } {
  const normalizedName = normalize(name);
  const [label, ...rest] = normalizedName.split(".");
  if (!label || rest.length === 0) {
    throw new Error(`Invalid ENS name ${name}`);
  }
  return {
    label,
    parentName: rest.join("."),
    normalizedName,
  };
}

function rootEthLabel(name: string): string {
  const normalizedName = normalize(name);
  const labels = normalizedName.split(".");
  if (labels.length !== 2 || labels[1] !== "eth") {
    throw new Error(`ENSv2 publish currently expects a second-level .eth name, got ${name}`);
  }
  return labels[0]!;
}

async function waitForReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
): Promise<void> {
  await publicClient.waitForTransactionReceipt({ hash });
}

async function readResolver(
  publicClient: ReturnType<typeof createPublicClient>,
  registryAddress: Address,
  node: Hex,
): Promise<Address> {
  return await publicClient.readContract({
    address: registryAddress,
    abi: ensRegistryAbi,
    functionName: "resolver",
    args: [node],
  }) as Address;
}

async function readV2Resolver(
  publicClient: ReturnType<typeof createPublicClient>,
  universalResolverAddress: Address,
  name: string,
): Promise<Address> {
  try {
    const result = await publicClient.readContract({
      address: universalResolverAddress,
      abi: universalResolverAbi,
      functionName: "findResolver",
      args: [toHex(packetToBytes(name))],
    }) as { resolver?: Address; 0?: Address };
    return result.resolver ?? result[0] ?? zeroAddress;
  } catch {
    return zeroAddress;
  }
}

async function getV2NameStatus(
  publicClient: ReturnType<typeof createPublicClient>,
  addresses: EnsAddresses,
  name: string,
): Promise<V2NameStatus> {
  const normalizedName = normalize(name);
  const label = rootEthLabel(normalizedName);
  const anyId = BigInt(labelhash(label));
  const node = namehash(normalizedName);
  const state = await publicClient.readContract({
    address: addresses.v2Registry,
    abi: v2RegistryAbi,
    functionName: "getState",
    args: [anyId],
  }) as {
    status?: number;
    expiry?: bigint;
    latestOwner?: Address;
    tokenId?: bigint;
    0?: number;
    1?: bigint;
    2?: Address;
    3?: bigint;
  };

  const status = Number(state.status ?? state[0] ?? 0);
  const expiry = state.expiry ?? state[1] ?? 0n;
  const latestOwner = state.latestOwner ?? state[2] ?? zeroAddress;
  const tokenId = state.tokenId ?? state[3] ?? 0n;
  let owner = latestOwner;

  if (status === 2 && tokenId !== 0n) {
    owner = await publicClient.readContract({
      address: addresses.v2Registry,
      abi: v2RegistryAbi,
      functionName: "ownerOf",
      args: [tokenId],
    }) as Address;
  }

  return {
    name: normalizedName,
    label,
    anyId,
    node,
    status,
    owner,
    latestOwner,
    tokenId,
    resolver: await readV2Resolver(publicClient, addresses.universalResolver, normalizedName),
    expiry: expiry === 0n ? null : Number(expiry),
  };
}

async function shouldPublishWithV2(
  publicClient: ReturnType<typeof createPublicClient>,
  addresses: EnsAddresses,
  config: EnsPublishConfig,
): Promise<boolean> {
  if (config.registryVersion === "v1") return false;
  if (config.registryVersion === "v2") return true;

  try {
    const status = await getV2NameStatus(publicClient, addresses, config.rootDomain);
    return status.status === 2;
  } catch {
    return false;
  }
}

async function getNameStatus(
  publicClient: ReturnType<typeof createPublicClient>,
  addresses: EnsAddresses,
  name: string,
): Promise<NameStatus> {
  const normalizedName = normalize(name);
  const node = namehash(normalizedName);
  const owner = await publicClient.readContract({
    address: addresses.registry,
    abi: ensRegistryAbi,
    functionName: "owner",
    args: [node],
  }) as Address;
  const resolver = await readResolver(publicClient, addresses.registry, node);
  const wrapped = lower(owner) === lower(addresses.nameWrapper);

  let wrappedOwner: Address | null = null;
  let expiry: number | null = null;
  if (wrapped) {
    const [resolvedOwner, , resolvedExpiry] = await publicClient.readContract({
      address: addresses.nameWrapper,
      abi: nameWrapperAbi,
      functionName: "getData",
      args: [BigInt(node)],
    }) as [Address, number, bigint];
    wrappedOwner = resolvedOwner;
    expiry = Number(resolvedExpiry);
  }

  return { name: normalizedName, node, owner, resolver, wrapped, wrappedOwner, expiry };
}

function assertControllableName(status: NameStatus, accountAddress: Address): void {
  if (status.wrapped) {
    if (!status.wrappedOwner || lower(status.wrappedOwner) !== lower(accountAddress)) {
      throw new Error(
        `ENS name ${status.name} is wrapped but controlled by ${status.wrappedOwner ?? "unknown"}, not ${accountAddress}`,
      );
    }
    return;
  }

  if (lower(status.owner) !== lower(accountAddress)) {
    throw new Error(`ENS name ${status.name} is owned by ${status.owner}, not ${accountAddress}`);
  }
}

async function ensureResolver(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: EnsAccount,
  addresses: EnsAddresses,
  status: NameStatus,
): Promise<Address> {
  if (status.resolver && status.resolver !== zeroAddress) {
    return status.resolver;
  }

  const hash = status.wrapped
    ? await walletClient.writeContract({
      account,
      chain: sepolia,
      address: addresses.nameWrapper,
      abi: nameWrapperAbi,
      functionName: "setResolver",
      args: [status.node, addresses.publicResolver],
    })
    : await walletClient.writeContract({
      account,
      chain: sepolia,
      address: addresses.registry,
      abi: ensRegistryAbi,
      functionName: "setResolver",
      args: [status.node, addresses.publicResolver],
    });

  await waitForReceipt(publicClient, hash);
  return addresses.publicResolver;
}

async function createSubname(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: EnsAccount,
  addresses: EnsAddresses,
  parentStatus: NameStatus,
  label: string,
  resolverAddress: Address,
): Promise<Hex> {
  const hash = parentStatus.wrapped
    ? await walletClient.writeContract({
      account,
      chain: sepolia,
      address: addresses.nameWrapper,
      abi: nameWrapperAbi,
      functionName: "setSubnodeRecord",
      args: [
        parentStatus.node,
        label,
        account.address,
        resolverAddress,
        0n,
        0,
        BigInt(parentStatus.expiry ?? Math.floor(Date.now() / 1000) + 31536000),
      ],
    })
    : await walletClient.writeContract({
      account,
      chain: sepolia,
      address: addresses.registry,
      abi: ensRegistryAbi,
      functionName: "setSubnodeRecord",
      args: [
        parentStatus.node,
        keccak256(stringToHex(label)),
        account.address,
        resolverAddress,
        0n,
      ],
    });

  await waitForReceipt(publicClient, hash);
  return hash;
}

async function writeTextRecords(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: EnsAccount,
  resolverAddress: Address,
  node: Hex,
  textRecords: Record<string, string>,
): Promise<Hex> {
  const calls = Object.entries(textRecords).map(([key, value]) =>
    encodeFunctionData({
      abi: publicResolverAbi,
      functionName: "setText",
      args: [node, key, value],
    }),
  );

  const hash = await walletClient.writeContract({
    account,
    chain: sepolia,
    address: resolverAddress,
    abi: publicResolverAbi,
    functionName: "multicall",
    args: [calls],
  });
  await waitForReceipt(publicClient, hash);
  return hash;
}

function auditTextRecords(entry: EnsAuditRecordInput): Record<string, string> {
  return {
    [`${TEXT_RECORD_PREFIX}.package`]: entry.packageName,
    [`${TEXT_RECORD_PREFIX}.version`]: entry.version,
    [`${TEXT_RECORD_PREFIX}.verdict`]: entry.verdict.toLowerCase(),
    [`${TEXT_RECORD_PREFIX}.score`]: String(entry.riskScore),
    [`${TEXT_RECORD_PREFIX}.report_cid`]: entry.reportCid,
    [`${TEXT_RECORD_PREFIX}.report_uri`]: entry.reportUri,
    [`${TEXT_RECORD_PREFIX}.tarball_cid`]: entry.tarballCid ?? "",
    [`${TEXT_RECORD_PREFIX}.tarball_uri`]: entry.tarballUri ?? "",
    [`${TEXT_RECORD_PREFIX}.source_cid`]: entry.sourceCid ?? "",
    [`${TEXT_RECORD_PREFIX}.source_uri`]: entry.sourceUri ?? "",
    [`${TEXT_RECORD_PREFIX}.source_path`]: entry.sourcePath ?? "",
    [`${TEXT_RECORD_PREFIX}.file_index_cid`]: entry.fileIndexCid ?? "",
    [`${TEXT_RECORD_PREFIX}.file_index_uri`]: entry.fileIndexUri ?? "",
    [`${TEXT_RECORD_PREFIX}.manifest_cid`]: entry.manifestCid,
    [`${TEXT_RECORD_PREFIX}.manifest_uri`]: entry.manifestUri,
    [`${TEXT_RECORD_PREFIX}.capabilities`]: entry.capabilities.join(","),
    [`${TEXT_RECORD_PREFIX}.date`]: entry.publishedAt,
  };
}

function latestTextRecords(entry: EnsAuditRecordInput, versionName: string): Record<string, string> {
  return {
    [`${TEXT_RECORD_PREFIX}.latest_version`]: entry.version,
    [`${TEXT_RECORD_PREFIX}.latest_version_name`]: versionName,
    [`${TEXT_RECORD_PREFIX}.latest_verdict`]: entry.verdict.toLowerCase(),
    [`${TEXT_RECORD_PREFIX}.latest_score`]: String(entry.riskScore),
    [`${TEXT_RECORD_PREFIX}.latest_report_cid`]: entry.reportCid,
    [`${TEXT_RECORD_PREFIX}.latest_report_uri`]: entry.reportUri,
    [`${TEXT_RECORD_PREFIX}.latest_tarball_cid`]: entry.tarballCid ?? "",
    [`${TEXT_RECORD_PREFIX}.latest_tarball_uri`]: entry.tarballUri ?? "",
    [`${TEXT_RECORD_PREFIX}.latest_source_cid`]: entry.sourceCid ?? "",
    [`${TEXT_RECORD_PREFIX}.latest_source_uri`]: entry.sourceUri ?? "",
    [`${TEXT_RECORD_PREFIX}.latest_source_path`]: entry.sourcePath ?? "",
    [`${TEXT_RECORD_PREFIX}.latest_file_index_cid`]: entry.fileIndexCid ?? "",
    [`${TEXT_RECORD_PREFIX}.latest_file_index_uri`]: entry.fileIndexUri ?? "",
    [`${TEXT_RECORD_PREFIX}.latest_manifest_cid`]: entry.manifestCid,
    [`${TEXT_RECORD_PREFIX}.latest_manifest_uri`]: entry.manifestUri,
    [`${TEXT_RECORD_PREFIX}.latest_capabilities`]: entry.capabilities.join(","),
    [`${TEXT_RECORD_PREFIX}.latest_date`]: entry.publishedAt,
  };
}

async function ensureV2Resolver(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: EnsAccount,
  addresses: EnsAddresses,
  status: V2NameStatus,
): Promise<Address> {
  if (status.resolver && status.resolver !== zeroAddress) {
    return status.resolver;
  }

  const hash = await walletClient.writeContract({
    account,
    chain: sepolia,
    address: addresses.v2Registry,
    abi: v2RegistryAbi,
    functionName: "setResolver",
    args: [status.anyId, addresses.publicResolver],
  });
  await waitForReceipt(publicClient, hash);

  const resolver = await readV2Resolver(publicClient, addresses.universalResolver, status.name);
  if (!resolver || resolver === zeroAddress) {
    throw new Error(`ENSv2 name ${status.name} still has no resolver after setResolver`);
  }
  return resolver;
}

async function publishEnsV2RootRecord(
  config: EnsPublishConfig,
  entry: EnsAuditRecordInput,
  clients: ReturnType<typeof createEnsClients>,
): Promise<EnsPublishResult> {
  const { account, publicClient, walletClient, addresses } = clients;
  const status = await getV2NameStatus(publicClient, addresses, config.rootDomain);
  if (status.status !== 2) {
    throw new Error(`ENSv2 name ${status.name} is not registered on Sepolia (status=${status.status})`);
  }
  if (lower(status.owner) !== lower(account.address)) {
    throw new Error(`ENSv2 name ${status.name} is owned by ${status.owner}, not ${account.address}`);
  }

  const resolverAddress = await ensureV2Resolver(
    publicClient,
    walletClient,
    account,
    addresses,
    status,
  );
  const packageLabel = ensSafeLabel(entry.packageName);
  const versionLabel = versionToEnsLabel(entry.version);
  const syntheticVersionName = `${versionLabel}.${packageLabel}.${status.name}`;
  const records = {
    ...auditTextRecords(entry),
    ...latestTextRecords(entry, status.name),
    [`${TEXT_RECORD_PREFIX}.registry`]: "ensv2",
    [`${TEXT_RECORD_PREFIX}.record_scope`]: "root",
    [`${TEXT_RECORD_PREFIX}.package_label`]: packageLabel,
    [`${TEXT_RECORD_PREFIX}.version_label`]: versionLabel,
    [`${TEXT_RECORD_PREFIX}.synthetic_version_name`]: syntheticVersionName,
  };

  const writeRecords = await writeTextRecords(
    publicClient,
    walletClient,
    account,
    resolverAddress,
    status.node,
    records,
  );

  return {
    parentName: status.name,
    versionName: status.name,
    registryVersion: "v2",
    recordName: status.name,
    resolverAddress,
    txHashes: {
      createParentSubname: null,
      createVersionSubname: null,
      writeVersionRecords: writeRecords,
      writeLatestRecords: writeRecords,
    },
  };
}

export async function publishEnsAuditRecord(
  config: EnsPublishConfig,
  entry: EnsAuditRecordInput,
): Promise<EnsPublishResult> {
  const { account, publicClient, walletClient, addresses } = createEnsClients(config);
  const clients = { account, publicClient, walletClient, addresses };
  if (await shouldPublishWithV2(publicClient, addresses, config)) {
    return publishEnsV2RootRecord(config, entry, clients);
  }

  const parentName = packageToParentEnsName(entry.packageName, config.rootDomain);
  const versionName = versionToEnsName(parentName, entry.version);
  const { label: packageLabel, parentName: baseDomain } = splitName(parentName);

  const baseDomainStatus = await getNameStatus(publicClient, addresses, baseDomain);
  if (!baseDomainStatus.owner || baseDomainStatus.owner === zeroAddress) {
    throw new Error(`Base ENS name ${baseDomain} is not registered on Sepolia`);
  }
  assertControllableName(baseDomainStatus, account.address);

  let parentStatus = await getNameStatus(publicClient, addresses, parentName);
  let createParentSubname: Hex | null = null;
  if (!parentStatus.owner || parentStatus.owner === zeroAddress) {
    createParentSubname = await createSubname(
      publicClient,
      walletClient,
      account,
      addresses,
      baseDomainStatus,
      packageLabel,
      addresses.publicResolver,
    );
    parentStatus = await getNameStatus(publicClient, addresses, parentName);
  }
  assertControllableName(parentStatus, account.address);

  const resolverAddress = await ensureResolver(
    publicClient,
    walletClient,
    account,
    addresses,
    parentStatus,
  );

  const createVersionSubname = await createSubname(
    publicClient,
    walletClient,
    account,
    addresses,
    parentStatus,
    versionToEnsLabel(entry.version),
    resolverAddress,
  );

  const versionNode = namehash(versionName);
  const writeVersionRecords = await writeTextRecords(
    publicClient,
    walletClient,
    account,
    resolverAddress,
    versionNode,
    auditTextRecords(entry),
  );
  const writeLatestRecords = await writeTextRecords(
    publicClient,
    walletClient,
    account,
    resolverAddress,
    parentStatus.node,
    latestTextRecords(entry, versionName),
  );

  return {
    parentName,
    versionName,
    registryVersion: "v1",
    recordName: versionName,
    resolverAddress,
    txHashes: {
      createParentSubname,
      createVersionSubname,
      writeVersionRecords,
      writeLatestRecords,
    },
  };
}
