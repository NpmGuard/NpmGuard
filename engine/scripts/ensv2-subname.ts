import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  isHex,
  keccak256,
  parseAbi,
  stringToBytes,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { labelhash, namehash, normalize, packetToBytes } from "viem/ens";

const DEFAULT_V2 = {
  registry: "0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67",
  resolverFactory: "0xd2A632D8A8b67C2c4398c255CBd7Af8Dd7236198",
  subregistryImplementation: "0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917",
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
} as const;

const v2RegistryAbi = parseAbi([
  "function getState(uint256 anyId) external view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
  "function getSubregistry(string label) external view returns (address)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expires) external returns (uint256 tokenId)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function setSubregistry(uint256 tokenId, address registry) external",
]);

const userRegistryAbi = parseAbi([
  "function initialize(address rootAccount, uint256 roleBitmap) external",
]);

const verifiableFactoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) external returns (address)",
]);

const resolverAbi = parseAbi([
  "function multicall(bytes[] data) external returns (bytes[] results)",
  "function setText(bytes32 node, string key, string value) external",
]);

const universalResolverAbi = parseAbi([
  "function findResolver(bytes name) external view returns ((address resolver, bytes32 node, uint256 offset))",
]);

const USER_REGISTRY_ID = keccak256(stringToBytes("UserRegistry"));
const USER_REGISTRY_VERSION = 0n;
const ALL_ROLES = BigInt(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const ROLE_UNREGISTER = 1n << 12n;
const ROLE_RENEW = 1n << 16n;
const ROLE_SET_SUBREGISTRY = 1n << 20n;
const ROLE_SET_RESOLVER = 1n << 24n;
const ROLE_UNREGISTER_ADMIN = ROLE_UNREGISTER << 128n;
const ROLE_RENEW_ADMIN = ROLE_RENEW << 128n;
const ROLE_SET_SUBREGISTRY_ADMIN = ROLE_SET_SUBREGISTRY << 128n;
const ROLE_SET_RESOLVER_ADMIN = ROLE_SET_RESOLVER << 128n;
const DEFAULT_OWNER_ROLE_BITMAP =
  ROLE_UNREGISTER |
  ROLE_RENEW |
  ROLE_SET_SUBREGISTRY |
  ROLE_SET_RESOLVER |
  ROLE_UNREGISTER_ADMIN |
  ROLE_RENEW_ADMIN |
  ROLE_SET_SUBREGISTRY_ADMIN |
  ROLE_SET_RESOLVER_ADMIN;

type Account = ReturnType<typeof privateKeyToAccount>;

interface V2Deployment {
  registry: Address;
  resolverFactory: Address;
  subregistryImplementation: Address;
  universalResolver: Address;
}

interface NameState {
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
  resource: bigint;
  owner: Address;
}

interface RegistryLookup {
  registry: Address;
  missingLabel: string | null;
  missingName: string | null;
}

interface ParentRegistryLookup extends RegistryLookup {
  label: string;
  parent: string;
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function collectFlag(name: string): string[] {
  const values: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) {
      values.push(process.argv[i + 1]!);
      i++;
    }
  }
  return values;
}

function positionalArgs(): string[] {
  const valueFlags = new Set([
    "--name",
    "--owner",
    "--resolver",
    "--duration",
    "--role-bitmap",
    "--root-account",
    "--text",
  ]);
  const result: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg.startsWith("--")) {
      if (valueFlags.has(arg)) i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run ensv2:subname -- <subname.parent.eth> [--owner 0x...] [--resolver 0x...] [--duration seconds]",
    "  npm run ensv2:subname -- react.npmguard-demo.eth --text npmguard.package=react",
    "",
    "Environment:",
    "  NPMGUARD_ENS_RPC_URL or SEPOLIA_RPC_URL is required.",
    "  NPMGUARD_ENS_PRIVATE_KEY or SEPOLIA_PRIVATE_KEY is required.",
    "",
    "What it does:",
    "  1. Deploys a UserRegistry for the parent ENSv2 name if needed.",
    "  2. Sets that subregistry on the parent name.",
    "  3. Registers the requested subname.",
    "  4. Writes smoke/text records on the subname unless --no-smoke-records is set.",
  ].join("\n");
}

function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  2);
}

function requiredEnv(primary: string, fallback?: string): string {
  const value = process.env[primary] ?? (fallback ? process.env[fallback] : undefined);
  if (!value) {
    throw new Error(`Missing required environment variable ${fallback ? `${primary} or ${fallback}` : primary}`);
  }
  return value;
}

function optionalAddress(value: string | undefined, fallback: string): Address {
  return getAddress(value ?? fallback);
}

function privateKeyHex(privateKey: string): Hex {
  return (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
}

function splitEnsName(name: string): string[] {
  const normalized = normalize(name);
  const labels = normalized.split(".");
  if (labels.length < 2 || labels.at(-1) !== "eth") {
    throw new Error(`ENSv2 script currently supports names under .eth only, got ${name}`);
  }
  return labels;
}

function splitSubname(name: string): { label: string; parent: string; normalizedName: string } {
  const normalizedName = normalize(name);
  const labels = splitEnsName(normalizedName);
  if (labels.length < 3) {
    throw new Error(`Expected a subname under a parent, got ${name}`);
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

function createDeployment(): V2Deployment {
  return {
    registry: optionalAddress(process.env.NPMGUARD_ENS_V2_REGISTRY_ADDRESS, DEFAULT_V2.registry),
    resolverFactory: optionalAddress(
      process.env.NPMGUARD_ENS_V2_RESOLVER_FACTORY_ADDRESS,
      DEFAULT_V2.resolverFactory,
    ),
    subregistryImplementation: optionalAddress(
      process.env.NPMGUARD_ENS_V2_SUBREGISTRY_IMPLEMENTATION_ADDRESS,
      DEFAULT_V2.subregistryImplementation,
    ),
    universalResolver: optionalAddress(
      process.env.NPMGUARD_ENS_UNIVERSAL_RESOLVER_ADDRESS,
      DEFAULT_V2.universalResolver,
    ),
  };
}

function createClients() {
  const rpcUrl = requiredEnv("NPMGUARD_ENS_RPC_URL", "SEPOLIA_RPC_URL");
  const account = privateKeyToAccount(privateKeyHex(requiredEnv("NPMGUARD_ENS_PRIVATE_KEY", "SEPOLIA_PRIVATE_KEY")));
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
  return { account, publicClient, walletClient, deployment: createDeployment() };
}

async function waitForReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
): Promise<void> {
  await publicClient.waitForTransactionReceipt({ hash });
}

async function readNameState(
  publicClient: ReturnType<typeof createPublicClient>,
  registry: Address,
  label: string,
): Promise<NameState> {
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

async function getSubregistry(
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
  deployment: V2Deployment,
  name: string,
): Promise<RegistryLookup> {
  const labels = splitEnsName(name);
  let registry = deployment.registry;

  for (let i = labels.length - 2; i >= 0; i--) {
    const label = labels[i]!;
    const subregistry = await getSubregistry(publicClient, registry, label);
    if (isAddressEqual(subregistry, zeroAddress)) {
      return {
        registry: zeroAddress,
        missingLabel: label,
        missingName: labels.slice(i).join("."),
      };
    }
    registry = subregistry;
  }

  return { registry, missingLabel: null, missingName: null };
}

async function getV2ParentRegistryForName(
  publicClient: ReturnType<typeof createPublicClient>,
  deployment: V2Deployment,
  name: string,
): Promise<ParentRegistryLookup> {
  const labels = splitEnsName(name);
  const label = labels[0]!;
  const parent = labels.slice(1).join(".");
  if (parent === "eth") {
    return {
      label,
      parent,
      registry: deployment.registry,
      missingLabel: null,
      missingName: null,
    };
  }

  const lookup = await getV2RegistryForName(publicClient, deployment, parent);
  return { label, parent, ...lookup };
}

async function readResolver(
  publicClient: ReturnType<typeof createPublicClient>,
  deployment: V2Deployment,
  name: string,
): Promise<Address> {
  try {
    const result = await publicClient.readContract({
      address: deployment.universalResolver,
      abi: universalResolverAbi,
      functionName: "findResolver",
      args: [toHex(packetToBytes(name))],
    }) as { resolver?: Address; 0?: Address };
    return result.resolver ?? result[0] ?? zeroAddress;
  } catch {
    return zeroAddress;
  }
}

function assertOwner(name: string, state: NameState, account: Account): void {
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

async function ensureSubregistryForName(options: {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: Account;
  deployment: V2Deployment;
  name: string;
}): Promise<{ subregistry: Address; deployTx: Hex | null; setTx: Hex | null; alreadySet: boolean }> {
  const current = await getV2RegistryForName(options.publicClient, options.deployment, options.name);
  if (!isAddressEqual(current.registry, zeroAddress)) {
    return { subregistry: current.registry, deployTx: null, setTx: null, alreadySet: true };
  }

  const parent = await getV2ParentRegistryForName(options.publicClient, options.deployment, options.name);
  if (isAddressEqual(parent.registry, zeroAddress)) {
    throw new Error(`Missing ENSv2 subregistry for ${parent.missingName}; cannot set subregistry for ${options.name}`);
  }

  const parentState = await readNameState(options.publicClient, parent.registry, parent.label);
  assertOwner(options.name, parentState, options.account);

  const salt = defaultUserRegistrySalt(options.name);
  const initializeData = encodeFunctionData({
    abi: userRegistryAbi,
    functionName: "initialize",
    args: [options.account.address, ALL_ROLES],
  });
  const deployData = encodeFunctionData({
    abi: verifiableFactoryAbi,
    functionName: "deployProxy",
    args: [options.deployment.subregistryImplementation, salt, initializeData],
  });
  const simulatedAddress = await simulateDeployProxyAddress({
    publicClient: options.publicClient,
    factory: options.deployment.resolverFactory,
    deployer: options.account.address,
    data: deployData,
  });
  if (!simulatedAddress) {
    throw new Error("Could not simulate UserRegistry deployment address");
  }

  const code = await options.publicClient.getCode({ address: simulatedAddress });
  let deployTx: Hex | null = null;
  if (!isHex(code) || code === "0x") {
    deployTx = await options.walletClient.writeContract({
      account: options.account,
      chain: sepolia,
      address: options.deployment.resolverFactory,
      abi: verifiableFactoryAbi,
      functionName: "deployProxy",
      args: [options.deployment.subregistryImplementation, salt, initializeData],
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

  const verified = await getV2RegistryForName(options.publicClient, options.deployment, options.name);
  if (!isAddressEqual(verified.registry, simulatedAddress)) {
    throw new Error(`Subregistry set failed for ${options.name}; expected ${simulatedAddress}, got ${verified.registry}`);
  }

  return { subregistry: simulatedAddress, deployTx, setTx, alreadySet: false };
}

function parseTextRecords(values: string[]): Record<string, string> {
  const records: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --text value "${value}", expected key=value`);
    records[value.slice(0, index)] = value.slice(index + 1);
  }
  return records;
}

async function writeTextRecords(options: {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: Account;
  resolver: Address;
  name: string;
  records: Record<string, string>;
}): Promise<Hex | null> {
  const entries = Object.entries(options.records);
  if (entries.length === 0 || isAddressEqual(options.resolver, zeroAddress)) return null;

  const node = namehash(options.name);
  const calls = entries.map(([key, value]) =>
    encodeFunctionData({
      abi: resolverAbi,
      functionName: "setText",
      args: [node, key, value],
    }),
  );
  const hash = await options.walletClient.writeContract({
    account: options.account,
    chain: sepolia,
    address: options.resolver,
    abi: resolverAbi,
    functionName: "multicall",
    args: [calls],
  });
  await waitForReceipt(options.publicClient, hash);
  return hash;
}

async function createSubname(options: {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: Account;
  deployment: V2Deployment;
  name: string;
  owner: Address;
  resolver: Address;
  durationSeconds: number;
  roleBitmap: bigint;
}): Promise<{ tx: Hex | null; alreadyRegistered: boolean; expiry: bigint }> {
  const { label, parent, normalizedName } = splitSubname(options.name);
  const parentLookup = await getV2RegistryForName(options.publicClient, options.deployment, parent);
  if (isAddressEqual(parentLookup.registry, zeroAddress)) {
    throw new Error(`Parent ${parent} has no ENSv2 subregistry`);
  }

  const existing = await readNameState(options.publicClient, parentLookup.registry, label);
  if (existing.status === 2) {
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
    args: [label, options.owner, zeroAddress, options.resolver, options.roleBitmap, expiry],
  });
  await waitForReceipt(options.publicClient, tx);

  const registered = await readNameState(options.publicClient, parentLookup.registry, label);
  if (registered.status !== 2) {
    throw new Error(`Subname ${normalizedName} was not registered after transaction ${tx}`);
  }
  return { tx, alreadyRegistered: false, expiry };
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const args = positionalArgs();
  const name = readFlag("--name") ?? args[0];
  if (!name) throw new Error(usage());

  const { label, parent, normalizedName } = splitSubname(name);
  const { account, publicClient, walletClient, deployment } = createClients();
  const owner = getAddress(readFlag("--owner") ?? account.address);
  const durationSeconds = Number(readFlag("--duration") ?? 31_536_000);
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error("--duration must be a positive integer number of seconds");
  }
  const roleBitmap = BigInt(readFlag("--role-bitmap") ?? DEFAULT_OWNER_ROLE_BITMAP);

  const subregistry = await ensureSubregistryForName({
    publicClient,
    walletClient,
    account,
    deployment,
    name: parent,
  });

  const explicitResolver = readFlag("--resolver");
  const resolver = explicitResolver ? getAddress(explicitResolver) : await readResolver(publicClient, deployment, parent);
  const subname = await createSubname({
    publicClient,
    walletClient,
    account,
    deployment,
    name: normalizedName,
    owner,
    resolver,
    durationSeconds,
    roleBitmap,
  });

  const textRecords = parseTextRecords(collectFlag("--text"));
  if (!hasFlag("--no-smoke-records")) {
    textRecords["npmguard.subname"] ??= normalizedName;
    textRecords["npmguard.parent"] ??= parent;
    textRecords["npmguard.label"] ??= label;
    textRecords["npmguard.date"] ??= new Date().toISOString();
  }
  const writeTextTx = await writeTextRecords({
    publicClient,
    walletClient,
    account,
    resolver,
    name: normalizedName,
    records: textRecords,
  });

  console.log(toJson({
    name: normalizedName,
    parent,
    label,
    owner,
    resolver,
    account: account.address,
    subregistry,
    subname,
    writeTextTx,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
