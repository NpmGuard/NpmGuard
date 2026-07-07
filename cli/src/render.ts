import chalk from "chalk";

/** Per-state tally carried on the 4-state verdict. All fields optional so the
 *  renderer is tolerant of partial payloads. */
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

/**
 * Render the 4-state verdict. Only DANGEROUS is a block; SUSPECT and UNKNOWN
 * inform. UNKNOWN is called out loudly — "couldn't analyze" must never read as
 * a quiet pass.
 */
export function renderVerdict(
  verdict: string,
  rationale = "",
  counts?: VerdictCounts,
): void {
  const v = verdict.toUpperCase();
  const bg =
    v === "SAFE"
      ? chalk.bgGreen.white.bold
      : v === "DANGEROUS"
        ? chalk.bgRed.white.bold
        : chalk.bgYellow.black.bold;
  const fg = v === "SAFE" ? chalk.green : v === "DANGEROUS" ? chalk.red : chalk.yellow;

  console.log();
  console.log(bg(`  ${v}  `));
  console.log();

  if (rationale) console.log(fg(rationale));
  if (v === "UNKNOWN") {
    console.log(
      chalk.yellow(
        "Coverage gap — parts of this package could not be analyzed. This is NOT a clean pass.",
      ),
    );
  }

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
