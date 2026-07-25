import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import * as api from "../api.js";
import { parsePackageArg, resolveLatestVersion } from "../utils.js";

interface AttestOpts {
  api: string;
  /** Print the URL instead of opening a browser (headless / CI / demo capture). */
  noOpen?: boolean;
}

const POLL_INTERVAL_MS = 2_000;
const DEADLINE_MS = 10 * 60 * 1_000;

const TIER_LABEL: Record<number, string> = {
  1: "human-attested",
  2: "identity-checked",
  3: "identity-checked + jurisdiction",
};

/**
 * Open a URL in the user's default browser. Best-effort: if it fails the URL is
 * already printed, so the flow degrades to copy-paste rather than dying.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is on screen; nothing else to do */
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `npmguard attest <pkg>@<version>` — prove a human published this release.
 *
 * The CLI deliberately does almost nothing: it opens a session, sends the user
 * to the browser, and watches. Every decision (does this GitHub user own the
 * package, does the proof bind to this exact tarball, what tier was proven)
 * happens server-side. The CLI never sees a key and never verifies a proof.
 */
export async function attestCommand(
  packageSpec: string,
  opts: AttestOpts,
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

  console.log();
  console.log(chalk.bold(`  Attesting ${name}@${version}`));
  console.log();

  const spinner = ora("Opening attestation session...").start();
  let session: api.AttestSession;
  try {
    session = await api.openAttestSession(apiUrl, name, version);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(
      message.includes("503")
        ? "This engine has no World ID attestation configured."
        : `Could not open an attestation session: ${message}`,
    );
    process.exit(1);
  }
  spinner.succeed(`Session ${session.sessionId}`);

  const url = session.url ?? `${apiUrl}/attest/${session.sessionId}`;
  console.log();
  console.log(chalk.cyan("  Finish in your browser — sign in with GitHub, then"));
  console.log(chalk.cyan("  scan the QR code with World App:"));
  console.log();
  console.log(`    ${chalk.underline(url)}`);
  console.log();
  if (!opts.noOpen) openBrowser(url);

  const waiting = ora("Waiting for your proof...").start();
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let current: api.AttestSession;
    try {
      current = await api.getAttestSession(apiUrl, session.sessionId);
    } catch {
      continue; // a transient blip must not abandon a session the user is mid-way through
    }
    if (current.status === "owned" && waiting.text !== "Waiting for your World ID proof...") {
      waiting.text = "Waiting for your World ID proof...";
    }
    if (current.status === "verified") {
      const attestation = current.attestation;
      waiting.succeed(`Attested ${current.packageName}@${current.version}`);
      console.log();
      if (attestation) {
        const label = TIER_LABEL[attestation.tier] ?? `tier ${attestation.tier}`;
        console.log(`  ${chalk.green("✓")} ${chalk.bold(label)}`);
        if (attestation.environment !== "production") {
          // Never let a staging proof read as a real-world assurance.
          console.log(
            chalk.yellow(
              `  ! World ID environment: ${attestation.environment} — not a production credential`,
            ),
          );
        }
        if (attestation.storageRoot) {
          console.log(chalk.gray(`  0G Storage: ${attestation.storageRoot}`));
        }
        if (attestation.chainTx) {
          console.log(chalk.gray(`  0G Chain:   ${attestation.chainTx}`));
        }
      }
      console.log();
      return;
    }
    if (current.status === "failed") {
      waiting.fail(current.error ?? "Attestation failed");
      process.exit(1);
    }
  }

  waiting.fail("Timed out waiting for the proof.");
  console.log(chalk.gray(`  The session is still open at ${url}`));
  process.exit(1);
}
