import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

// Email on DANGEROUS (spec decision 4): the 3am-malware case must reach a
// human even if nobody is watching the PR. SMTP URL config over a vendor SDK
// (repo rule: configuration over abstraction). Without NPMGUARD_SMTP_URL the
// alert still lands on the dashboard — email is additive.

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.smtpUrl) return null;
  if (!transporter) transporter = nodemailer.createTransport(config.smtpUrl);
  return transporter;
}

export async function sendDangerousEmail(
  org: string,
  recipients: string[],
  packageName: string,
  version: string,
  exposureLines: string[],
): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    console.log(`[email] SMTP not configured — skipping DANGEROUS mail for ${org}`);
    return;
  }
  if (recipients.length === 0) {
    console.log(`[email] no recipients with known emails for org ${org}`);
    return;
  }

  const reportUrl = `${config.panelBaseUrl}/package/${encodeURIComponent(packageName)}`;
  try {
    await transport.sendMail({
      from: config.alertFrom,
      to: recipients.join(", "),
      subject: `[NpmGuard] DANGEROUS: ${packageName}@${version} affects ${org}`,
      text: [
        `NpmGuard's audit found ${packageName}@${version} to be DANGEROUS.`,
        "",
        "Exposure:",
        ...exposureLines.map((l) => `  - ${l}`),
        "",
        `Full report: ${reportUrl}`,
        `Dashboard: ${config.panelBaseUrl}/dashboard`,
      ].join("\n"),
    });
    console.log(`[email] DANGEROUS alert for ${packageName}@${version} sent to ${org} (${recipients.length} recipients)`);
  } catch (err) {
    console.error("[email] send failed:", err instanceof Error ? err.message : err);
  }
}
