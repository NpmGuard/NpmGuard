import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  stringToBytes,
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
  v2ResolverFactory: "0xd2A632D8A8b67C2c4398c255CBd7Af8Dd7236198",
  v2SubregistryImplementation: "0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917",
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
    stateMutability: "view",
    name: "getSubregistry",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "register",
    inputs: [
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "registry", type: "address" },
      { name: "resolver", type: "address" },
      { name: "roleBitmap", type: "uint256" },
      { name: "expires", type: "uint64" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setSubregistry",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "registry", type: "address" },
    ],
    outputs: [],
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

const userRegistryAbi = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "initialize",
    inputs: [
      { name: "rootAccount", type: "address" },
      { name: "roleBitmap", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const verifiableFactoryAbi = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "deployProxy",
    inputs: [
      { name: "implementation", type: "address" },
      { name: "salt", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const USER_REGISTRY_ID = keccak256(stringToBytes("UserRegistry"));
const USER_REGISTRY_VERSION = 0n;
const ALL_ROLES = BigInt(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const ROLE_UNREGISTER = 1n << 12n;
const ROLE_RENEW = 1n << 16n;
const ROLE_SET_SUBREGISTRY = 1n << 20n;
const ROLE_SET_RESOLVER = 1n << 24n;
const DEFAULT_OWNER_ROLE_BITMAP =
  ROLE_UNREGISTER |
  ROLE_RENEW |
  ROLE_SET_SUBREGISTRY |
  ROLE_SET_RESOLVER |
  (ROLE_UNREGISTER << 128n) |
  (ROLE_RENEW << 128n) |
  (ROLE_SET_SUBREGISTRY << 128n) |
  (ROLE_SET_RESOLVER << 128n);
const DEFAULT_V2_SUBNAME_DURATION_SECONDS = 31_536_000;

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
  v2ResolverFactoryAddress?: string;
  v2SubregistryImplementationAddress?: string;
  v2SubnameDurationSeconds?: number;
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
  v2ResolverFactory: Address;
  v2SubregistryImplementation: Address;
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

interface V2GenericNameState {
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
  resource: bigint;
  owner: Address;
}

interface V2RegistryLookup {
  registry: Address;
  missingName: string | null;
}

interface V2ParentRegistryLookup extends V2RegistryLookup {
  label: string;
  parent: string;
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
    v2ResolverFactory: toAddress(config.v2ResolverFactoryAddress ?? DEFAULT_SEPOLIA_ENS.v2ResolverFactory),
    v2SubregistryImplementation: toAddress(
      config.v2SubregistryImplementationAddress ?? DEFAULT_SEPOLIA_ENS.v2SubregistryImplementation,
    ),
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

function splitEnsName(name: string): string[] {
  const normalizedName = normalize(name);
  const labels = normalizedName.split(".");
  if (labels.length < 2 || labels.at(-1) !== "eth") {
    throw new Error(`ENSv2 publish currently supports names under .eth only, got ${name}`);
  }
  return labels;
}

function splitV2Subname(name: string): { label: string; parent: string; normalizedName: string } {
  const normalizedName = normalize(name);
  const labels = splitEnsName(normalizedName);
  if (labels.length < 3) {
    throw new Error(`Expected an ENSv2 subname under a parent, got ${name}`);
  }
  return {
    label: labels[0]!,
    parent: labels.slice(1).join("."),
    normalizedName,
  };
}

function v2LabelId(label: string): bigint {
  return BigInt(labelhash(label));
}

function defaultUserRegistrySalt(name: string): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [USER_REGISTRY_ID, namehash(name), USER_REGISTRY_VERSION],
      ),
    ),
  );
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

async function readV2GenericNameState(
  publicClient: ReturnType<typeof createPublicClient>,
  registry: Address,
  label: string,
): Promise<V2GenericNameState> {
  const raw = await publicClient.readContract({
    address: registry,
    abi: v2RegistryAbi,
    functionName: "getState",
    args: [v2LabelId(label)],
  }) as {
    status?: number;
    expiry?: bigint;
    latestOwner?: Address;
    tokenId?: bigint;
    resource?: bigint;
    0?: number;
    1?: bigint;
    2?: Address;
    3?: bigint;
    4?: bigint;
  };

  const status = Number(raw.status ?? raw[0] ?? 0);
  const expiry = raw.expiry ?? raw[1] ?? 0n;
  const latestOwner = raw.latestOwner ?? raw[2] ?? zeroAddress;
  const tokenId = raw.tokenId ?? raw[3] ?? 0n;
  const resource = raw.resource ?? raw[4] ?? 0n;
  let owner = latestOwner;

  if (status === 2 && tokenId !== 0n) {
    owner = await publicClient.readContract({
      address: registry,
      abi: v2RegistryAbi,
      functionName: "ownerOf",
      args: [tokenId],
    }) as Address;
  }

  return { status, expiry, latestOwner, tokenId, resource, owner };
}

async function getV2Subregistry(
  publicClient: ReturnType<typeof createPublicClient>,
  registry: Address,
  label: string,
): Promise<Address> {
  return await publicClient.readContract({
    address: registry,
    abi: v2RegistryAbi,
    functionName: "getSubregistry",
    args: [label],
  }) as Address;
}

async function getV2RegistryForName(
  publicClient: ReturnType<typeof createPublicClient>,
  addresses: EnsAddresses,
  name: string,
): Promise<V2RegistryLookup> {
  const labels = splitEnsName(name);
  let registry = addresses.v2Registry;

  for (let i = labels.length - 2; i >= 0; i--) {
    const label = labels[i]!;
    const subregistry = await getV2Subregistry(publicClient, registry, label);
    if (isAddressEqual(subregistry, zeroAddress)) {
      return {
        registry: zeroAddress,
        missingName: labels.slice(i).join("."),
      };
    }
    registry = subregistry;
  }

  return { registry, missingName: null };
}

async function getV2ParentRegistryForName(
  publicClient: ReturnType<typeof createPublicClient>,
  addresses: EnsAddresses,
  name: string,
): Promise<V2ParentRegistryLookup> {
  const labels = splitEnsName(name);
  const label = labels[0]!;
  const parent = labels.slice(1).join(".");
  if (parent === "eth") {
    return {
      label,
      parent,
      registry: addresses.v2Registry,
      missingName: null,
    };
  }

  const lookup = await getV2RegistryForName(publicClient, addresses, parent);
  return { label, parent, ...lookup };
}

function assertV2Owner(name: string, state: V2GenericNameState, account: EnsAccount): void {
  if (state.status !== 2) {
    throw new Error(`${name} is not registered in its ENSv2 registry (status=${state.status})`);
  }
  if (!isAddressEqual(state.owner, account.address)) {
    throw new Error(`${name} is owned by ${state.owner}, not ${account.address}`);
  }
}

async function simulateDeployProxyAddress(options: {
  publicClient: ReturnType<typeof createPublicClient>;
  factory: Address;
  deployer: Address;
  data: Hex;
}): Promise<Address | null> {
  try {
    const result = await options.publicClient.call({
      account: options.deployer,
      to: options.factory,
      data: options.data,
    });
    if (!result.data || result.data === "0x") return null;
    return decodeFunctionResult({
      abi: verifiableFactoryAbi,
      functionName: "deployProxy",
      data: result.data,
    }) as Address;
  } catch {
    return null;
  }
}

async function ensureV2SubregistryForName(options: {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: EnsAccount;
  addresses: EnsAddresses;
  name: string;
}): Promise<{ subregistry: Address; deployTx: Hex | null; setTx: Hex | null; alreadySet: boolean }> {
  const current = await getV2RegistryForName(options.publicClient, options.addresses, options.name);
  if (!isAddressEqual(current.registry, zeroAddress)) {
    return { subregistry: current.registry, deployTx: null, setTx: null, alreadySet: true };
  }

  const parent = await getV2ParentRegistryForName(options.publicClient, options.addresses, options.name);
  if (isAddressEqual(parent.registry, zeroAddress)) {
    throw new Error(`Missing ENSv2 subregistry for ${parent.missingName}; cannot set subregistry for ${options.name}`);
  }

  const parentState = await readV2GenericNameState(options.publicClient, parent.registry, parent.label);
  assertV2Owner(options.name, parentState, options.account);

  const salt = defaultUserRegistrySalt(options.name);
  const initializeData = encodeFunctionData({
    abi: userRegistryAbi,
    functionName: "initialize",
    args: [options.account.address, ALL_ROLES],
  });
  const deployData = encodeFunctionData({
    abi: verifiableFactoryAbi,
    functionName: "deployProxy",
    args: [options.addresses.v2SubregistryImplementation, salt, initializeData],
  });
  const simulatedAddress = await simulateDeployProxyAddress({
    publicClient: options.publicClient,
    factory: options.addresses.v2ResolverFactory,
    deployer: options.account.address,
    data: deployData,
  });
  if (!simulatedAddress) {
    throw new Error("Could not simulate ENSv2 UserRegistry deployment address");
  }

  const code = await options.publicClient.getCode({ address: simulatedAddress });
  let deployTx: Hex | null = null;
  if (!code || code === "0x") {
    deployTx = await options.walletClient.writeContract({
      account: options.account,
      chain: sepolia,
      address: options.addresses.v2ResolverFactory,
      abi: verifiableFactoryAbi,
      functionName: "deployProxy",
      args: [options.addresses.v2SubregistryImplementation, salt, initializeData],
    });
    await waitForReceipt(options.publicClient, deployTx);
  }

  const setTx = await options.walletClient.writeContract({
    account: options.account,
    chain: sepolia,
    address: parent.registry,
    abi: v2RegistryAbi,
    functionName: "setSubregistry",
    args: [parentState.tokenId, simulatedAddress],
  });
  await waitForReceipt(options.publicClient, setTx);

  const verified = await getV2RegistryForName(options.publicClient, options.addresses, options.name);
  if (!isAddressEqual(verified.registry, simulatedAddress)) {
    throw new Error(`Subregistry set failed for ${options.name}; expected ${simulatedAddress}, got ${verified.registry}`);
  }

  return { subregistry: simulatedAddress, deployTx, setTx, alreadySet: false };
}

async function createV2Subname(options: {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: EnsAccount;
  addresses: EnsAddresses;
  name: string;
  owner: Address;
  resolver: Address;
  durationSeconds: number;
}): Promise<{ tx: Hex | null; alreadyRegistered: boolean; expiry: bigint }> {
  const { label, parent, normalizedName } = splitV2Subname(options.name);
  const parentLookup = await getV2RegistryForName(options.publicClient, options.addresses, parent);
  if (isAddressEqual(parentLookup.registry, zeroAddress)) {
    throw new Error(`Parent ${parent} has no ENSv2 subregistry`);
  }

  const existing = await readV2GenericNameState(options.publicClient, parentLookup.registry, label);
  if (existing.status === 2) {
    assertV2Owner(normalizedName, existing, options.account);
    return { tx: null, alreadyRegistered: true, expiry: existing.expiry };
  }

  const block = await options.publicClient.getBlock();
  const expiry = block.timestamp + BigInt(options.durationSeconds);
  const tx = await options.walletClient.writeContract({
    account: options.account,
    chain: sepolia,
    address: parentLookup.registry,
    abi: v2RegistryAbi,
    functionName: "register",
    args: [label, options.owner, zeroAddress, options.resolver, DEFAULT_OWNER_ROLE_BITMAP, expiry],
  });
  await waitForReceipt(options.publicClient, tx);

  const registered = await readV2GenericNameState(options.publicClient, parentLookup.registry, label);
  if (registered.status !== 2) {
    throw new Error(`Subname ${normalizedName} was not registered after transaction ${tx}`);
  }

  return { tx, alreadyRegistered: false, expiry };
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
  const packageName = `${packageLabel}.${status.name}`;
  const syntheticVersionName = `${versionLabel}.${packageName}`;
  const rootRecords = {
    ...auditTextRecords(entry),
    ...latestTextRecords(entry, packageName),
    [`${TEXT_RECORD_PREFIX}.registry`]: "ensv2",
    [`${TEXT_RECORD_PREFIX}.record_scope`]: "root",
    [`${TEXT_RECORD_PREFIX}.package_label`]: packageLabel,
    [`${TEXT_RECORD_PREFIX}.version_label`]: versionLabel,
    [`${TEXT_RECORD_PREFIX}.synthetic_version_name`]: syntheticVersionName,
  };

  await ensureV2SubregistryForName({
    publicClient,
    walletClient,
    account,
    addresses,
    name: status.name,
  });
  const durationSeconds = Math.max(
    1,
    Math.floor(config.v2SubnameDurationSeconds ?? DEFAULT_V2_SUBNAME_DURATION_SECONDS),
  );
  const packageSubname = await createV2Subname({
    publicClient,
    walletClient,
    account,
    addresses,
    name: packageName,
    owner: account.address,
    resolver: resolverAddress,
    durationSeconds,
  });
  const packageRecords = {
    ...auditTextRecords(entry),
    ...latestTextRecords(entry, packageName),
    [`${TEXT_RECORD_PREFIX}.registry`]: "ensv2",
    [`${TEXT_RECORD_PREFIX}.record_scope`]: "package",
    [`${TEXT_RECORD_PREFIX}.package_label`]: packageLabel,
    [`${TEXT_RECORD_PREFIX}.version_label`]: versionLabel,
    [`${TEXT_RECORD_PREFIX}.synthetic_version_name`]: syntheticVersionName,
  };

  const writePackageRecords = await writeTextRecords(
    publicClient,
    walletClient,
    account,
    resolverAddress,
    namehash(packageName),
    packageRecords,
  );
  const writeRootRecords = await writeTextRecords(
    publicClient,
    walletClient,
    account,
    resolverAddress,
    status.node,
    rootRecords,
  );

  return {
    parentName: packageName,
    versionName: packageName,
    registryVersion: "v2",
    recordName: packageName,
    resolverAddress,
    txHashes: {
      createParentSubname: packageSubname.tx,
      createVersionSubname: null,
      writeVersionRecords: writePackageRecords,
      writeLatestRecords: writeRootRecords,
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
