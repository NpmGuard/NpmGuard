import "dotenv/config";
import { loadReport } from "../src/report-store.js";
import { saveStoragePublication } from "../src/storage-store.js";
import { publishAuditStorage } from "../src/storage/publisher.js";

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function positionalArgs(): string[] {
  const valueFlags = new Set(["--package", "--version", "--tarball", "--source-dir"]);
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
    "  npm run storage:publish -- <package> [version] [--source-dir /path/package] [--tarball /path/package.tgz] [--report-only] [--skip-ens]",
    "",
    "Environment:",
    "  NPMGUARD_PINATA_JWT or PINATA_JWT is required.",
    "  ENS publish is enabled when NPMGUARD_ENS_RPC_URL/SEPOLIA_RPC_URL and NPMGUARD_ENS_PRIVATE_KEY/SEPOLIA_PRIVATE_KEY are set.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = positionalArgs();
  const packageName = readFlag("--package") ?? args[0];
  const version = readFlag("--version") ?? args[1];
  if (!packageName) {
    throw new Error(usage());
  }

  const loaded = loadReport(packageName, version ?? undefined);
  if (!loaded) {
    throw new Error(`No local report found for ${packageName}${version ? `@${version}` : ""}`);
  }

  const result = await publishAuditStorage({
    packageName,
    version: loaded.version,
    report: loaded.report,
    tarballPath: readFlag("--tarball") ?? undefined,
    sourceDirectoryPath: readFlag("--source-dir") ?? undefined,
    includeSource: !hasFlag("--report-only"),
    publishEns: !hasFlag("--skip-ens"),
  });

  saveStoragePublication(result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
