import chalk from "chalk";
import ora from "ora";
import { spawnSync } from "node:child_process";
import { formatEther } from "viem";
import * as api from "../api.js";
import {
  parsePackageArg,
  prompt,
  resolveLatestVersion,
  detectPackageManager,
} from "../utils.js";
import { auditCommand } from "./audit.js";
import { payViaWalletConnect, readAuditFee } from "../wallet/walletconnect.js";
import { streamAuditEvents } from "../stream.js";

interface InstallOpts {
  api: string;
  force?: boolean;
}

/**
 * Run the correct "add this package" command for the detected package manager.
 * `npm install <pkg>` adds the package. `pnpm add <pkg>` / `yarn add <pkg>` do
 * the same. Crucially, `yarn install <pkg>` would ignore <pkg> in yarn classic.
 */
function runInstall(packageSpec: string): number {
  const pm = detectPackageManager();
  const verb = pm === "npm" ? "install" : "add";
  console.log(chalk.gray(`\n  Running: ${pm} ${verb} ${packageSpec}\n`));
  const res = spawnSync(pm, [verb, packageSpec], { stdio: "inherit" });
  return res.status ?? 1;
}

function extractVerdict(report: api.PackageReport): string {
  const nested = (report as { report?: { verdict?: string } }).report?.verdict;
  return (nested ?? report.verdict ?? "UNKNOWN").toUpperCase();
}

function extractCapabilities(report: api.PackageReport): string[] {
  const nested = (report as { report?: { capabilities?: string[] } }).report
    ?.capabilities;
  return nested ?? (report.capabilities as string[] | undefined) ?? [];
}

export async function installCommand(
  packageSpec: string,
  opts: InstallOpts,
): Promise<void> {
  const apiUrl = opts.api;

  let parsed: { name: string; version?: string };
  try {
    parsed = parsePackageArg(packageSpec);
  } catch {
    console.error(chalk.red(`Invalid package: ${packageSpec}`));
    process.exit(1);
  }

  let { name, version } = parsed;
  if (!version) {
    const spinner = ora(`Resolving latest version of ${name}...`).start();
    const resolved = await resolveLatestVersion(name);
    if (!resolved) {
      spinner.fail("Could not resolve version from npm registry.");
      process.exit(1);
    }
    version = resolved;
    spinner.succeed(`Resolved ${name}@${version}`);
  }

  const fullSpec = `${name}@${version}`;
  console.log();
  console.log(chalk.bold(`  ${fullSpec}`));
  console.log();

  const spinner = ora("Checking NpmGuard audit...").start();
  let report: api.PackageReport | null;
  try {
    report = await api.getPackageReport(apiUrl, name, version);
  } catch (err) {
    spinner.fail(
      "Could not reach NpmGuard API: " +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }
  spinner.stop();

  if (report) {
    handleExistingReport(report, name, fullSpec, apiUrl, opts);
    return;
  }

  // No audit found — ask how to pay
  console.log(chalk.gray("  NOT AUDITED — no NpmGuard record for this version."));
  console.log();
  console.log(chalk.bold("  How do you want to pay for the audit?"));
  console.log("    1) Stripe (credit card)");
  console.log("    2) WalletConnect — ETH on Base Sepolia");
  console.log("    3) Install without audit (at your own risk)");
  console.log("    4) Cancel");
  console.log();
  const choice = await prompt("  Choice [1/2/3/4]: ");

  if (choice === "1") {
    await runStripeAuditAndInstall(fullSpec, name, version, apiUrl);
    return;
  }

  if (choice === "2") {
    await runCryptoAuditAndInstall(fullSpec, name, version, apiUrl);
    return;
  }

  if (choice === "3") {
    console.log(
      chalk.yellow("  Installing without audit. Proceed at your own risk."),
    );
    process.exit(runInstall(fullSpec));
  }

  console.log(chalk.gray("  Cancelled."));
  process.exit(0);
}

function handleExistingReport(
  report: api.PackageReport,
  name: string,
  fullSpec: string,
  apiUrl: string,
  opts: InstallOpts,
): void {
  const verdict = extractVerdict(report);
  const capabilities = extractCapabilities(report);

  if (verdict === "SAFE") {
    console.log(chalk.green("  ✓ SAFE — audited by NpmGuard"));
    if (capabilities.length > 0) {
      console.log(chalk.gray(`  Capabilities: ${capabilities.join(", ")}`));
    }
    process.exit(runInstall(fullSpec));
  }

  if (verdict === "DANGEROUS" || verdict === "CRITICAL" || verdict === "WARNING") {
    console.log(chalk.bgRed.white.bold(`  ${verdict}  `));
    if (capabilities.length > 0) {
      console.log(
        chalk.red("  Capabilities: ") +
          capabilities.map((c) => chalk.yellow(c)).join(", "),
      );
    }
    console.log(
      chalk.dim(
        `  Full report: ${apiUrl}/package/${encodeURIComponent(name)}/report`,
      ),
    );
    console.log();

    if (opts.force) {
      console.log(chalk.yellow("  --force passed, installing anyway..."));
      process.exit(runInstall(fullSpec));
    }

    promptAndInstallIfAccepted(fullSpec, "  Install anyway? This package is flagged. (y/N) ");
    return;
  }

  console.log(chalk.yellow(`  Verdict: ${verdict}`));
  promptAndInstallIfAccepted(fullSpec, "  Proceed with install? (y/N) ");
}

async function promptAndInstallIfAccepted(
  fullSpec: string,
  question: string,
): Promise<void> {
  const answer = await prompt(chalk.red.bold(question));
  if (answer === "y" || answer === "yes") {
    process.exit(runInstall(fullSpec));
  }
  console.log(chalk.gray("  Aborted."));
  process.exit(1);
}

async function runStripeAuditAndInstall(
  fullSpec: string,
  name: string,
  version: string,
  apiUrl: string,
): Promise<void> {
  try {
    await auditCommand(fullSpec, { api: apiUrl, exit: false });
  } catch (err) {
    console.error(
      chalk.red(
        "Audit failed: " + (err instanceof Error ? err.message : String(err)),
      ),
    );
    process.exit(1);
  }
  await finalizeAfterAudit(fullSpec, name, version, apiUrl);
}

async function runCryptoAuditAndInstall(
  fullSpec: string,
  name: string,
  version: string,
  apiUrl: string,
): Promise<void> {
  // 1. Read current fee from contract
  let feeWei: bigint;
  try {
    feeWei = await readAuditFee();
  } catch (err) {
    console.error(
      chalk.red(
        "Could not read fee from contract: " +
          (err instanceof Error ? err.message : String(err)),
      ),
    );
    process.exit(1);
  }
  const feeDisplay = `${formatEther(feeWei)} ETH`;

  const confirm = await prompt(
    chalk.yellow(`  Pay ${feeDisplay} on Base Sepolia? (y/N) `),
  );
  if (confirm !== "y" && confirm !== "yes") {
    console.log(chalk.gray("  Cancelled."));
    process.exit(0);
  }

  // 2. WalletConnect → user signs → we get txHash
  const result = await payViaWalletConnect(name, version, feeWei, feeDisplay);
  if (!result.paid || !result.txHash) {
    console.log(chalk.red("  Payment failed, aborting."));
    process.exit(1);
  }

  // 3. Engine verifies txHash + returns auditId
  const startSpinner = ora("  Starting audit on engine...").start();
  let auditId: string;
  try {
    const res = await api.startAuditWithTxHash(
      apiUrl,
      name,
      version,
      result.txHash,
    );
    auditId = res.auditId;
    startSpinner.succeed(`Audit started (id: ${auditId})`);
  } catch (err) {
    startSpinner.fail(
      "Engine rejected txHash: " +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }

  console.log(
    chalk.cyan(`  Watch live: ${apiUrl}/audit/${auditId}`),
  );
  console.log();

  // 4. Stream the audit we just paid for (do NOT call auditCommand — that
  //    would trigger a second, unpaid audit via /checkout).
  await streamAuditEvents(apiUrl, auditId);

  // 5. Fetch the persisted report and decide whether to install
  await finalizeAfterAudit(fullSpec, name, version, apiUrl);
}

async function finalizeAfterAudit(
  fullSpec: string,
  name: string,
  version: string,
  apiUrl: string,
): Promise<void> {
  const freshReport = await api.getPackageReport(apiUrl, name, version);
  if (!freshReport) {
    console.log(chalk.red("  Audit finished but report not found."));
    process.exit(1);
  }
  const verdict = extractVerdict(freshReport);
  if (verdict === "SAFE") {
    console.log(chalk.green("\n  ✓ SAFE — proceeding with install"));
    process.exit(runInstall(fullSpec));
  }
  console.log(chalk.red(`\n  Audit verdict: ${verdict}`));
  const confirm = await prompt(chalk.red.bold("  Install anyway? (y/N) "));
  if (confirm === "y" || confirm === "yes") {
    process.exit(runInstall(fullSpec));
  }
  process.exit(1);
}
