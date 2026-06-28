import chalk from "chalk";
import ora from "ora";
import { spawnSync } from "node:child_process";
import { formatEther } from "viem";
import type { Hex } from "viem";
import * as api from "../api.js";
import {
  parsePackageArg,
  prompt,
  resolveLatestVersion,
  detectPackageManager,
  openExternalUrl,
} from "../utils.js";
import { auditCommand } from "./audit.js";
import { payViaWalletConnect, readAuditFee } from "../wallet/walletconnect.js";
import { streamAuditEvents } from "../stream.js";
import {
  defaultEnsRootDomain,
  defaultEnsRpcUrl,
  normalizeInstallSource,
  resolveEnsInstallSpec,
  resolvePinataInstallSpec,
  resolvePublishedInstallSpec,
  type InstallSource,
} from "../install-source.js";

interface InstallOpts {
  api: string;
  web: string;
  force?: boolean;
  installSource?: string;
  ensRoot?: string;
  ensRpc?: string;
}

const POST_AUDIT_STORAGE_WAIT_MS = Number(process.env.NPMGUARD_STORAGE_WAIT_MS ?? 90_000);

/**
 * Run the correct "add this package" command for the detected package manager.
 * `npm install <pkg>` adds the package. `pnpm add <pkg>` / `yarn add <pkg>` do
 * the same. Crucially, `yarn install <pkg>` would ignore <pkg> in yarn classic.
 */
function runInstall(packageSpec: string, label?: string): number {
  const pm = detectPackageManager();
  const verb = pm === "npm" ? "install" : "add";
  console.log(chalk.gray(`\n  Running: ${pm} ${verb} ${packageSpec}${label ? `\n  Source: ${label}` : ""}\n`));
  const res = spawnSync(pm, [verb, packageSpec], { stdio: "inherit" });
  return res.status ?? 1;
}

async function resolveInstallTarget(
  fullSpec: string,
  packageName: string,
  version: string,
  opts: InstallOpts,
  waitForPublishedMs = 0,
): Promise<{ spec: string; detail: string }> {
  const source = normalizeInstallSource(opts.installSource) as InstallSource;
  const rootDomain = opts.ensRoot ?? defaultEnsRootDomain();
  const rpcUrl = opts.ensRpc ?? defaultEnsRpcUrl();

  if (source === "auto") {
    const deadline = Date.now() + waitForPublishedMs;
    do {
      const published = await resolvePublishedInstallSpec({
        apiUrl: opts.api,
        packageName,
        version,
        rootDomain,
        rpcUrl,
      });
      if (published) return published;
      if (Date.now() < deadline) await delay(3000);
    } while (Date.now() < deadline);

    return { spec: fullSpec, detail: "npm registry (ENS/Pinata publication not available yet)" };
  }

  if (source === "npm") {
    return { spec: fullSpec, detail: "npm registry" };
  }
  if (source === "pinata") {
    return retryInstallSource(
      () => resolvePinataInstallSpec(opts.api, packageName, version),
      waitForPublishedMs,
    );
  }
  return retryInstallSource(
    () => resolveEnsInstallSpec({
      packageName,
      version,
      rootDomain,
      rpcUrl,
    }),
    waitForPublishedMs,
  );
}

async function installSafePackage(
  fullSpec: string,
  packageName: string,
  version: string,
  opts: InstallOpts,
  waitForPublishedMs = 0,
): Promise<never> {
  let target: { spec: string; detail: string };
  try {
    target = await resolveInstallTarget(fullSpec, packageName, version, opts, waitForPublishedMs);
  } catch (err) {
    console.error(
      chalk.red(
        "Could not resolve install source: " +
          (err instanceof Error ? err.message : String(err)),
      ),
    );
    console.log(chalk.gray("  Retry with --install-source npm to install from the npm registry."));
    process.exit(1);
  }
  process.exit(runInstall(target.spec, target.detail));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryInstallSource(
  resolve: () => Promise<{ spec: string; detail: string }>,
  waitMs: number,
): Promise<{ spec: string; detail: string }> {
  const deadline = Date.now() + waitMs;
  let lastError: unknown;
  do {
    try {
      return await resolve();
    } catch (err) {
      lastError = err;
      if (Date.now() < deadline) await delay(3000);
    }
  } while (Date.now() < deadline);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  const webUrl = opts.web;

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
    await handleExistingReport(report, name, version, fullSpec, apiUrl, opts);
    return;
  }

  // No audit found — ask how to pay
  console.log(chalk.gray("  NOT AUDITED — no NpmGuard record for this version."));
  console.log();
  console.log(chalk.bold("  How do you want to pay for the audit?"));
  console.log("    1) Stripe (credit card)");
  console.log("    2) Browser wallet — MetaMask/Rabby in Brave or Chrome");
  console.log("    3) WalletConnect — QR/mobile wallet");
  console.log("    4) Install without audit (at your own risk)");
  console.log("    5) Cancel");
  console.log();
  const choice = await prompt("  Choice [1/2/3/4/5]: ");

  if (choice === "1") {
    await runStripeAuditAndInstall(fullSpec, name, version, apiUrl, opts);
    return;
  }

  if (choice === "2") {
    await runBrowserWalletAuditAndInstall(fullSpec, name, version, apiUrl, webUrl, opts);
    return;
  }

  if (choice === "3") {
    await runCryptoAuditAndInstall(fullSpec, name, version, apiUrl, opts);
    return;
  }

  if (choice === "4") {
    console.log(
      chalk.yellow("  Installing without audit. Proceed at your own risk."),
    );
    process.exit(runInstall(fullSpec, "npm registry (audit skipped)"));
  }

  console.log(chalk.gray("  Cancelled."));
  process.exit(0);
}

async function handleExistingReport(
  report: api.PackageReport,
  name: string,
  version: string,
  fullSpec: string,
  apiUrl: string,
  opts: InstallOpts,
): Promise<void> {
  const verdict = extractVerdict(report);
  const capabilities = extractCapabilities(report);

  if (verdict === "SAFE") {
    console.log(chalk.green("  ✓ SAFE — audited by NpmGuard"));
    if (capabilities.length > 0) {
      console.log(chalk.gray(`  Capabilities: ${capabilities.join(", ")}`));
    }
    await installSafePackage(fullSpec, name, version, opts);
    return;
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
      await installSafePackage(fullSpec, name, version, opts);
      return;
    }

    await promptAndInstallIfAccepted(fullSpec, name, version, opts, "  Install anyway? This package is flagged. (y/N) ");
    return;
  }

  console.log(chalk.yellow(`  Verdict: ${verdict}`));
  await promptAndInstallIfAccepted(fullSpec, name, version, opts, "  Proceed with install? (y/N) ");
}

async function promptAndInstallIfAccepted(
  fullSpec: string,
  name: string,
  version: string,
  opts: InstallOpts,
  question: string,
): Promise<void> {
  const answer = await prompt(chalk.red.bold(question));
  if (answer === "y" || answer === "yes") {
    await installSafePackage(fullSpec, name, version, opts);
  }
  console.log(chalk.gray("  Aborted."));
  process.exit(1);
}

async function runStripeAuditAndInstall(
  fullSpec: string,
  name: string,
  version: string,
  apiUrl: string,
  opts: InstallOpts,
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
  await finalizeAfterAudit(fullSpec, name, version, apiUrl, opts);
}

function buildBrowserWalletUrl(
  webUrl: string,
  packageName: string,
  version: string,
): string {
  const url = new URL("/pay", webUrl.replace(/\/+$/, ""));
  url.searchParams.set("packageName", packageName);
  url.searchParams.set("version", version);
  url.searchParams.set("source", "cli");
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return delay(ms);
}

async function waitForPackageReport(
  apiUrl: string,
  packageName: string,
  version: string,
  timeoutMs: number,
): Promise<api.PackageReport | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = await api.getPackageReport(apiUrl, packageName, version);
    if (report) return report;
    await sleep(3000);
  }
  return null;
}

async function runBrowserWalletAuditAndInstall(
  fullSpec: string,
  name: string,
  version: string,
  apiUrl: string,
  webUrl: string,
  opts: InstallOpts,
): Promise<void> {
  const paymentUrl = buildBrowserWalletUrl(webUrl, name, version);

  console.log();
  console.log(chalk.bold("  Open this URL in Brave or Chrome with MetaMask/Rabby:"));
  console.log(chalk.blue.underline(`  ${paymentUrl}`));
  console.log();
  console.log(chalk.gray("  The browser page will connect your wallet, sign the Base Sepolia tx, and start the audit."));
  console.log(chalk.gray("  Keep this terminal open; it will continue when the report is ready."));
  console.log();

  const openAnswer = await prompt("  Open it now in your default browser? (Y/n) ");
  if (openAnswer !== "n" && openAnswer !== "no") {
    const opened = openExternalUrl(paymentUrl);
    if (!opened) {
      console.log(chalk.yellow("  Could not open automatically. Copy the URL above."));
    }
  }

  const spinner = ora("  Waiting for browser payment and audit report...").start();
  let report: api.PackageReport | null = null;
  try {
    report = await waitForPackageReport(apiUrl, name, version, 30 * 60 * 1000);
  } catch (err) {
    spinner.fail(
      "Could not read report: " +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }

  if (!report) {
    spinner.fail("Timed out waiting for the browser audit report.");
    console.log(chalk.gray(`  Check ${webUrl.replace(/\/+$/, "")}/package/${encodeURIComponent(name)}`));
    process.exit(1);
  }

  spinner.succeed("Audit report received");
  await finalizeWithReport(fullSpec, name, version, report, opts, POST_AUDIT_STORAGE_WAIT_MS);
}

async function runCryptoAuditAndInstall(
  fullSpec: string,
  name: string,
  version: string,
  apiUrl: string,
  opts: InstallOpts,
): Promise<void> {
  // 1. Read current fee from the engine's public config, then fall back to
  // direct contract read if the engine is older or config is unavailable.
  let feeWei: bigint;
  let contractAddress: Hex | undefined;
  try {
    const publicConfig = await api.getPublicConfig(apiUrl);
    const contract = publicConfig.crypto?.contract;
    const auditFeeWei = publicConfig.crypto?.auditFeeWei;
    if (contract && /^0x[0-9a-fA-F]{40}$/.test(contract) && auditFeeWei) {
      contractAddress = contract as Hex;
      feeWei = BigInt(auditFeeWei);
    } else {
      feeWei = await readAuditFee();
    }
  } catch (err) {
    try {
      feeWei = await readAuditFee();
    } catch {
      console.error(
        chalk.red(
          "Could not read fee from engine or contract: " +
            (err instanceof Error ? err.message : String(err)),
        ),
      );
      process.exit(1);
    }
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
  const result = await payViaWalletConnect(name, version, feeWei, feeDisplay, contractAddress);
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
  await finalizeAfterAudit(fullSpec, name, version, apiUrl, opts);
}

async function finalizeAfterAudit(
  fullSpec: string,
  name: string,
  version: string,
  apiUrl: string,
  opts: InstallOpts,
): Promise<void> {
  const freshReport = await api.getPackageReport(apiUrl, name, version);
  if (!freshReport) {
    console.log(chalk.red("  Audit finished but report not found."));
    process.exit(1);
  }
  await finalizeWithReport(fullSpec, name, version, freshReport, opts, POST_AUDIT_STORAGE_WAIT_MS);
}

async function finalizeWithReport(
  fullSpec: string,
  name: string,
  version: string,
  report: api.PackageReport,
  opts: InstallOpts,
  waitForPublishedMs = 0,
): Promise<void> {
  const verdict = extractVerdict(report);
  if (verdict === "SAFE") {
    console.log(chalk.green("\n  ✓ SAFE — proceeding with install"));
    await installSafePackage(fullSpec, name, version, opts, waitForPublishedMs);
  }
  console.log(chalk.red(`\n  Audit verdict: ${verdict}`));
  const confirm = await prompt(chalk.red.bold("  Install anyway? (y/N) "));
  if (confirm === "y" || confirm === "yes") {
    await installSafePackage(fullSpec, name, version, opts);
  }
  process.exit(1);
}
