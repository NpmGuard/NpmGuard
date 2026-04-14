import chalk from "chalk";
import ora from "ora";
import EventSource from "eventsource";
import { renderVerdict, renderFinding, renderPhase } from "./render.js";
import type { Finding } from "./render.js";

export interface StreamResult {
  verdict: string;
  exitCode: number;
}

/**
 * Connect to the engine SSE stream for an existing audit and render events
 * until a verdict or error arrives. Does not exit the process.
 */
export async function streamAuditEvents(
  apiUrl: string,
  auditId: string,
): Promise<StreamResult> {
  const eventsUrl = `${apiUrl}/audit/${encodeURIComponent(auditId)}/events`;
  const es = new EventSource(eventsUrl);
  const spinner = ora("Audit in progress...").start();

  let verdict = "UNKNOWN";
  let exitCode = 0;

  await new Promise<void>((resolve) => {
    es.addEventListener("phase_started", (event) => {
      try {
        const data = JSON.parse(event.data);
        spinner.text = renderPhase(data.phase ?? data.name ?? "");
      } catch {
        // ignore
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
        // ignore
      }
    });

    es.addEventListener("verdict_reached", (event) => {
      try {
        const data = JSON.parse(event.data);
        spinner.stop();
        verdict = (data.verdict ?? "UNKNOWN").toString().toUpperCase();
        renderVerdict(
          verdict,
          data.capabilities ?? [],
          data.proofCount ?? data.findings?.length ?? 0,
        );
        exitCode = verdict === "SAFE" ? 0 : 1;
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
      if (es.readyState === EventSource.CLOSED) {
        spinner.stop();
        es.close();
        resolve();
      }
    };
  });

  return { verdict, exitCode };
}
