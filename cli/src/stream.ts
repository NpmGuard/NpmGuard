import chalk from "chalk";
import ora from "ora";
import EventSource from "eventsource";
import { renderVerdict, renderUnusableVerdict, renderHypothesisResolved, renderPhase } from "./render.js";
import { asVerdict, type Verdict } from "./api.js";

export interface StreamResult {
  /** `null` when the stream ended without a usable verdict — an error, a dropped
   *  connection, or a value outside the domain. Never a third verdict. */
  verdict: Verdict | null;
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

  // Non-zero until a verdict actually arrives: a stream that drops mid-audit must
  // not read to a CI gate as a clean pass.
  let verdict: Verdict | null = null;
  let exitCode = 1;

  await new Promise<void>((resolve) => {
    es.addEventListener("phase_started", (event) => {
      try {
        const data = JSON.parse(event.data);
        spinner.text = renderPhase(data.phase ?? data.name ?? "");
      } catch {
        // ignore
      }
    });

    es.addEventListener("hypothesis_resolved", (event) => {
      try {
        const data = JSON.parse(event.data);
        if ((data.state ?? "").toString().toUpperCase() !== "CONFIRMED") return;
        spinner.stop();
        renderHypothesisResolved(data);
        spinner.start();
      } catch {
        // ignore
      }
    });

    es.addEventListener("verdict_reached", (event) => {
      try {
        const data = JSON.parse(event.data);
        spinner.stop();
        verdict = asVerdict(data.verdict);
        if (verdict === null) {
          renderUnusableVerdict(data.verdict);
        } else {
          renderVerdict(verdict, data.rationale ?? "", data.counts);
          exitCode = verdict === "SAFE" ? 0 : 1;
        }
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
