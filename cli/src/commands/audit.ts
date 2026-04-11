import chalk from "chalk";
import ora from "ora";
import qrcode from "qrcode-terminal";
import EventSource from "eventsource";
import * as api from "../api.js";
import { renderVerdict, renderFinding, renderPhase } from "../render.js";
import type { Finding } from "../render.js";

function parsePackageArg(pkg: string): { name: string; version?: string } {
  // Handle scoped packages: @scope/name@version
  if (pkg.startsWith("@")) {
    const slashIndex = pkg.indexOf("/");
    if (slashIndex === -1) {
      throw new Error(`Invalid scoped package name: ${pkg}`);
    }
    const rest = pkg.slice(slashIndex + 1);
    const atIndex = rest.lastIndexOf("@");
    if (atIndex > 0) {
      return {
        name: pkg.slice(0, slashIndex + 1 + atIndex),
        version: rest.slice(atIndex + 1),
      };
    }
    return { name: pkg };
  }

  // Handle unscoped packages: name@version
  const atIndex = pkg.lastIndexOf("@");
  if (atIndex > 0) {
    return {
      name: pkg.slice(0, atIndex),
      version: pkg.slice(atIndex + 1),
    };
  }

  return { name: pkg };
}

export async function auditCommand(
  pkg: string,
  opts: { api: string },
): Promise<void> {
  const apiUrl = opts.api;

  // 1. Parse package name and version
  let parsed: { name: string; version?: string };
  try {
    parsed = parsePackageArg(pkg);
  } catch {
    console.error(chalk.red(`Invalid package: ${pkg}`));
    process.exit(1);
  }

  console.log(
    chalk.bold(`Auditing ${parsed.name}`) +
      (parsed.version ? chalk.gray(`@${parsed.version}`) : ""),
  );
  console.log();

  // 1b. Check if already audited
  const existing = await api.getPackageReport(apiUrl, parsed.name, parsed.version);
  if (existing) {
    console.log(chalk.yellow("This package has already been audited."));
    console.log();
    const verdict = (existing as { report?: { verdict?: string } }).report?.verdict ?? existing.verdict ?? "UNKNOWN";
    renderVerdict(
      verdict,
      (existing as { report?: { capabilities?: string[] } }).report?.capabilities ?? [],
      (existing as { report?: { proofs?: unknown[] } }).report?.proofs?.length ?? 0,
    );
    console.log();
    console.log(chalk.dim(`View full report: ${apiUrl}/package/${encodeURIComponent(parsed.name)}/report`));
    process.exit(verdict === "SAFE" ? 0 : 1);
  }

  // 2. Try checkout — if payments not configured (501), go straight to free audit
  const spinner = ora("Connecting...").start();
  let auditId: string;

  let checkoutResult: { status: number; data: api.CheckoutResponse | null };
  try {
    checkoutResult = await api.checkoutRaw(apiUrl, parsed.name, parsed.version);
  } catch (err) {
    spinner.fail(
      "Failed to create checkout session: " +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }

  if (checkoutResult.status === 501 || !checkoutResult.data) {
    // Payments not configured — start audit directly (dev/free mode)
    spinner.text = "Starting audit (no payment required)...";
    try {
      const auditRes = await api.startAuditFree(apiUrl, parsed.name, parsed.version);
      auditId = auditRes.auditId;
    } catch (err) {
      spinner.fail(
        "Failed to start audit: " +
          (err instanceof Error ? err.message : String(err)),
      );
      process.exit(1);
    }
  } else {
    // Payment required — show URL + QR + poll
    spinner.stop();

    const link = chalk.blue.underline(checkoutResult.data.url);
    console.log(chalk.bold("Pay to start the audit:"));
    console.log(link);
    console.log();

    qrcode.generate(checkoutResult.data.url, { small: true });
    console.log();

    spinner.start("Waiting for payment...");

    let status: api.CheckoutStatus;
    try {
      status = await new Promise<api.CheckoutStatus>((resolve, reject) => {
        const interval = setInterval(async () => {
          try {
            const s = await api.pollCheckoutStatus(apiUrl, checkoutResult.data!.sessionId);
            if (s.paid) {
              clearInterval(interval);
              resolve(s);
            }
          } catch (err) {
            clearInterval(interval);
            reject(err);
          }
        }, 3000);
      });
    } catch (err) {
      spinner.fail(
        "Payment polling failed: " +
          (err instanceof Error ? err.message : String(err)),
      );
      process.exit(1);
    }

    spinner.text = "Payment confirmed. Starting audit...";

    if (status.auditId) {
      auditId = status.auditId;
    } else {
      try {
        const auditRes = await api.startAudit(apiUrl, checkoutResult.data.sessionId);
        auditId = auditRes.auditId;
      } catch (err) {
        spinner.fail(
          "Failed to start audit: " +
            (err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
    }
  }

  spinner.text = "Audit in progress...";

  // 9. Connect to SSE
  const eventsUrl = `${apiUrl}/audit/${encodeURIComponent(auditId)}/events`;
  const es = new EventSource(eventsUrl);

  let exitCode = 0;

  await new Promise<void>((resolve) => {
    es.addEventListener("phase_started", (event) => {
      try {
        const data = JSON.parse(event.data);
        spinner.text = renderPhase(data.phase ?? data.name ?? "");
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("finding_discovered", (event) => {
      try {
        const data = JSON.parse(event.data);
        const finding: Finding = data.finding ?? data;
        spinner.stop();
        renderFinding(finding);
        spinner.start();
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("verdict_reached", (event) => {
      try {
        const data = JSON.parse(event.data);
        spinner.stop();
        renderVerdict(
          data.verdict ?? "UNKNOWN",
          data.capabilities ?? [],
          data.proofCount ?? data.findings?.length ?? 0,
        );
        exitCode = data.verdict?.toUpperCase() === "SAFE" ? 0 : 1;
      } catch {
        spinner.stop();
      }
      es.close();
      resolve();
    });

    es.addEventListener("audit_error", (event) => {
      try {
        const data = JSON.parse(event.data);
        spinner.fail(chalk.red("Audit error: " + (data.error ?? event.data)));
      } catch {
        spinner.fail(chalk.red("Audit error: " + event.data));
      }
      exitCode = 1;
      es.close();
      resolve();
    });

    es.onerror = () => {
      // EventSource will auto-reconnect; if it closes, we resolve
      if (es.readyState === EventSource.CLOSED) {
        spinner.stop();
        es.close();
        resolve();
      }
    };
  });

  process.exit(exitCode);
}
