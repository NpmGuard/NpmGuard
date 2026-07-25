import chalk from "chalk";
import type { Verdict } from "./api.js";

/** Per-state hypothesis tally carried alongside the verdict. All fields optional
 *  so the renderer is tolerant of partial payloads. */
export interface VerdictCounts {
  total?: number;
  open?: number;
  inProgress?: number;
  confirmed?: number;
  refuted?: number;
  inconclusive?: number;
  deferred?: number;
}

/** A hypothesis resolution as it arrives over SSE. */
export interface ResolvedHypothesis {
  hypId?: string;
  claim?: string;
  severity?: string;
  state?: string;
  reason?: string;
}

export function renderVerdict(
  verdict: Verdict,
  rationale = "",
  counts?: VerdictCounts,
): void {
  const safe = verdict === "SAFE";
  const bg = safe ? chalk.bgGreen.white.bold : chalk.bgRed.white.bold;
  const fg = safe ? chalk.green : chalk.red;

  console.log();
  console.log(bg(`  ${verdict}  `));
  console.log();

  if (rationale) console.log(fg(rationale));

  if (counts) {
    const parts: string[] = [];
    if (counts.confirmed) parts.push(`${counts.confirmed} confirmed`);
    const pending = (counts.open ?? 0) + (counts.inProgress ?? 0);
    if (pending) parts.push(`${pending} pending`);
    if (counts.refuted) parts.push(`${counts.refuted} refuted`);
    if (counts.inconclusive) parts.push(`${counts.inconclusive} inconclusive`);
    if (counts.deferred) parts.push(`${counts.deferred} deferred`);
    if (parts.length) console.log(chalk.gray(`Hypotheses: ${parts.join(", ")}`));
  }
  console.log();
}

/**
 * The engine sent something that is not a verdict. Reported as the protocol
 * failure it is, never as a hedged result — the caller exits non-zero and does
 * not install.
 */
export function renderUnusableVerdict(raw: unknown): void {
  console.log();
  console.log(chalk.bgRed.white.bold("  UNUSABLE RESPONSE  "));
  console.log(
    chalk.red(
      `The engine reported a verdict of ${JSON.stringify(raw)}, which is not one it can produce.` +
        " Nothing was installed. Check that the CLI and the engine are the same version.",
    ),
  );
  console.log();
}

/**
 * Render a single hypothesis resolution during streaming. Only CONFIRMED ones
 * are shown inline (they are the alarming, reproduced results); the rest are
 * summarized in the final verdict counts.
 */
export function renderHypothesisResolved(h: ResolvedHypothesis): void {
  if ((h.state ?? "").toUpperCase() !== "CONFIRMED") return;
  console.log();
  console.log(
    chalk.red.bold("! CONFIRMED ") +
      chalk.white.bold(h.claim ?? "threat") +
      (h.severity ? chalk.gray(` (${h.severity})`) : ""),
  );
  if (h.reason) console.log(chalk.gray("  ") + chalk.white(h.reason));
}

export function renderPhase(phase: string): string {
  const phaseLabels: Record<string, string> = {
    resolve: "Resolving package...",
    inventory: "Taking inventory...",
    "intent-extraction": "Reading stated purpose...",
    triage: "Triaging files...",
    orchestrator: "Investigating hypotheses...",
    downloading: "Downloading package...",
    unpacking: "Unpacking archive...",
    static_analysis: "Running static analysis...",
    dynamic_analysis: "Running dynamic analysis...",
    ai_review: "AI reviewing code...",
    scoring: "Calculating score...",
    finalizing: "Finalizing report...",
  };

  return phaseLabels[phase] ?? `Phase: ${phase}...`;
}
