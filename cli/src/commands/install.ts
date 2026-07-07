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

/** Read a field off a report that may be flat or wrapped in `{ report: {...} }`. */
function reportField<T>(report: api.PackageReport, key: string): T | undefined {
  const r = report as Record<string, unknown> & { report?: Record<string, unknown> };
  return (r?.report?.[key] ?? r?.[key]) as T | undefined;
}

function extractVerdict(report: api.PackageReport): string {
  return (reportField<string>(report, "verdict") ?? "UNKNOWN").toUpperCase();
}

function extractRationale(report: api.PackageReport): string {
  return reportField<string>(report, "rationale") ?? "";
}

interface HypLite {
  claim?: { kind?: string };
  state?: string;
  description?: string;
  severity?: string;
}

/** Print the CONFIRMED hypotheses (the reproduced threats) that justify DANGEROUS. */
function printConfirmed(report: api.PackageReport): void {
  const hyps = reportField<HypLite[]>(report, "hypotheses") ?? [];
  const confirmed = hyps.filter((h) => (h.state ?? "").toUpperCase() === "CONFIRMED");
  for (const h of confirmed) {
    console.log(
      chalk.red.bold("  ! ") +
        chalk.white(h.description ?? h.claim?.kind ?? "confirmed threat"),
    );
  }
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
  const rationale = extractRationale(report);
  const reportUrl = `${apiUrl}/package/${encodeURIComponent(name)}/report`;

  // SAFE — the only silent-install path.
  if (verdict === "SAFE") {
    console.log(chalk.green("  ✓ SAFE — audited by NpmGuard"));
    if (rationale) console.log(chalk.gray(`  ${rationale}`));
    process.exit(runInstall(fullSpec));
  }

  // DANGEROUS — the only hard block. A CONFIRMED hypothesis with reproduced
  // evidence. --force overrides.
  if (verdict === "DANGEROUS") {
    console.log(chalk.bgRed.white.bold("  DANGEROUS  "));
    if (rationale) console.log(chalk.red(`  ${rationale}`));
    printConfirmed(report);
    console.log(chalk.dim(`  Full report: ${reportUrl}`));
    console.log();

    if (opts.force) {
      console.log(chalk.yellow("  --force passed, installing anyway..."));
      process.exit(runInstall(fullSpec));
    }
    promptAndInstallIfAccepted(
      fullSpec,
      "  Install anyway? This package has confirmed malicious behavior. (y/N) ",
    );
    return;
  }

  // SUSPECT / UNKNOWN — do not block, but warn honestly and prompt. UNKNOWN is
  // called out loudly: "couldn't analyze" must never read as a clean pass.
  console.log(chalk.bgYellow.black.bold(`  ${verdict}  `));
  if (verdict === "UNKNOWN") {
    console.log(
      chalk.yellow(
        "  Coverage gap — NpmGuard could not analyze part of this package. This is NOT a clean bill of health.",
      ),
    );
  } else {
    console.log(chalk.yellow("  Some hypotheses are still unresolved."));
  }
  if (rationale) console.log(chalk.yellow(`  ${rationale}`));
  console.log(chalk.dim(`  Full report: ${reportUrl}`));
  console.log();

  if (opts.force) {
    console.log(chalk.yellow("  --force passed, installing anyway..."));
    process.exit(runInstall(fullSpec));
  }
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
  // Same 4-state gate as a pre-existing report: SAFE installs, DANGEROUS blocks
  // (prompt), SUSPECT/UNKNOWN warn + prompt.
  handleExistingReport(freshReport, name, fullSpec, apiUrl, { api: apiUrl });
}
