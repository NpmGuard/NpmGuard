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
import { resolveChain, type ChainTarget } from "../contract.js";
import { streamAuditEvents } from "../stream.js";

interface InstallOpts {
  api: string;
  force?: boolean;
  chain?: string;
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

  // No audit found — but attestation history is a separate axis and exists
  // whether or not anyone audited this package. This is the case the signal
  // matters most in: a worm's freshly published version has no audit yet, and
  // it is precisely then that "the previous releases were attested and this one
  // is not" is the only thing anyone can act on.
  const continuity = await api.getPublisherContinuity(apiUrl, name, version);
  console.log(chalk.gray("  NOT AUDITED — no NpmGuard record for this version."));
  if (continuity) printContinuity({ publisherContinuity: continuity } as api.PackageReport);
  console.log();
  console.log(chalk.bold("  How do you want to pay for the audit?"));
  console.log("    1) Stripe (credit card)");
  console.log("    2) WalletConnect — pay on-chain from a mobile wallet");
  console.log("    3) Install without audit (at your own risk)");
  console.log("    4) Cancel");
  console.log();
  const choice = await prompt("  Choice [1/2/3/4]: ");

  if (choice === "1") {
    await runStripeAuditAndInstall(fullSpec, name, version, apiUrl);
    return;
  }

  if (choice === "2") {
    await runCryptoAuditAndInstall(fullSpec, name, version, apiUrl, opts.chain);
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

/**
 * Print the publisher-continuity line, if there is anything to say.
 *
 * Returns true when the signal is serious enough that the install must not be
 * silent. NO_HISTORY prints nothing at all: nearly every npm package is
 * unattested, and a warning that fires on everything is one users learn to
 * scroll past — which costs nothing until the day it is right.
 */
function printContinuity(report: api.PackageReport): boolean {
  const c = report.publisherContinuity;
  if (!c || c.status === "NO_HISTORY") return false;

  if (c.status === "BREAK") {
    console.log(chalk.bgRed.white.bold("  PUBLISHER BREAK  "));
    console.log(chalk.red(`  ${c.summary}`));
    if (c.publisher) {
      console.log(
        chalk.red(`  Previous ${c.streak} releases: ${c.publisher.slice(0, 18)}…`),
      );
    }
    return true;
  }

  if (c.status === "NEW_PUBLISHER") {
    console.log(chalk.bgYellow.black.bold("  NEW PUBLISHER  "));
    console.log(chalk.yellow(`  ${c.summary}`));
    return true;
  }

  if (c.status === "ATTESTED") {
    const tier = c.tier >= 2 ? "identity-checked" : "human-attested";
    console.log(chalk.green(`  ✓ Publisher ${tier} (${c.streak} in a row)`));
    return false;
  }

  console.log(chalk.gray(`  ${c.summary}`));
  return false;
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

  // SAFE — normally the only silent-install path. Continuity can still stop it:
  // the code being harmless says nothing about whether the person who published
  // it is the person who published every version before. That is precisely the
  // case a stolen token produces, and the case this whole feature exists for.
  if (verdict === "SAFE") {
    console.log(chalk.green("  ✓ SAFE — audited by NpmGuard"));
    if (rationale) console.log(chalk.gray(`  ${rationale}`));
    const alarming = printContinuity(report);
    if (!alarming) process.exit(runInstall(fullSpec));

    console.log(chalk.dim(`  Full report: ${reportUrl}`));
    console.log();
    if (opts.force) {
      console.log(chalk.yellow("  --force passed, installing anyway..."));
      process.exit(runInstall(fullSpec));
    }
    promptAndInstallIfAccepted(
      fullSpec,
      "  The code looks clean, but the publisher changed. Install anyway? (y/N) ",
    );
    return;
  }

  // DANGEROUS — the only hard block. A CONFIRMED hypothesis with reproduced
  // evidence. --force overrides.
  if (verdict === "DANGEROUS") {
    console.log(chalk.bgRed.white.bold("  DANGEROUS  "));
    if (rationale) console.log(chalk.red(`  ${rationale}`));
    printConfirmed(report);
    printContinuity(report);
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
  printContinuity(report);
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

/**
 * Pick the settlement chain. The engine is the authority on which chains are
 * usable and at which address — a chain the engine has no contract for could
 * take a real payment it would then refuse to verify.
 */
async function selectChain(
  apiUrl: string,
  requested?: string,
): Promise<ChainTarget> {
  let options: api.ChainOption[];
  try {
    options = api.chainOptions(await api.getPublicConfig(apiUrl));
  } catch (err) {
    console.error(
      chalk.red(
        "Could not read engine chain config: " +
          (err instanceof Error ? err.message : String(err)),
      ),
    );
    process.exit(1);
  }

  const targets = options
    .map((option) => resolveChain(option.chain, option.contract))
    .filter((target): target is ChainTarget => target !== null);

  if (targets.length === 0) {
    console.log(chalk.red("  This engine has no on-chain payment configured."));
    process.exit(1);
  }

  if (requested) {
    const match = targets.find((target) => target.name === requested);
    if (!match) {
      console.log(
        chalk.red(
          `  Chain '${requested}' is not available. This engine offers: ${targets
            .map((target) => target.name)
            .join(", ")}`,
        ),
      );
      process.exit(1);
    }
    return match;
  }

  if (targets.length === 1) return targets[0];

  console.log();
  console.log(chalk.bold("  Which chain do you want to pay on?"));
  targets.forEach((target, index) =>
    console.log(`    ${index + 1}) ${target.label}`),
  );
  console.log();
  const answer = await prompt(`  Choice [1-${targets.length}]: `);
  const picked = targets[Number(answer) - 1];
  if (!picked) {
    console.log(chalk.gray("  Cancelled."));
    process.exit(0);
  }
  return picked;
}

async function runCryptoAuditAndInstall(
  fullSpec: string,
  name: string,
  version: string,
  apiUrl: string,
  requestedChain?: string,
): Promise<void> {
  const target = await selectChain(apiUrl, requestedChain);

  // 1. Read current fee from the contract on the selected chain
  let feeWei: bigint;
  try {
    feeWei = await readAuditFee(target);
  } catch (err) {
    console.error(
      chalk.red(
        "Could not read fee from contract: " +
          (err instanceof Error ? err.message : String(err)),
      ),
    );
    process.exit(1);
  }
  const symbol = target.chain.nativeCurrency.symbol;
  const feeDisplay = `${formatEther(feeWei)} ${symbol}`;

  const confirm = await prompt(
    chalk.yellow(`  Pay ${feeDisplay} on ${target.label}? (y/N) `),
  );
  if (confirm !== "y" && confirm !== "yes") {
    console.log(chalk.gray("  Cancelled."));
    process.exit(0);
  }

  // 2. WalletConnect → user signs → we get txHash
  const result = await payViaWalletConnect(
    name,
    version,
    feeWei,
    feeDisplay,
    target,
  );
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
      target.name,
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
