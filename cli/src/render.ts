import chalk from "chalk";

export interface Finding {
  problem: string;
  evidence?: string;
  capabilities?: string[];
  severity?: string;
}

export function renderVerdict(
  verdict: string,
  capabilities: string[],
  proofCount: number,
): void {
  const isSafe = verdict.toUpperCase() === "SAFE";
  const color = isSafe ? chalk.green : chalk.red;
  const bgColor = isSafe ? chalk.bgGreen.white.bold : chalk.bgRed.white.bold;

  console.log();
  console.log(bgColor(`  ${verdict.toUpperCase()}  `));
  console.log();

  if (capabilities.length > 0) {
    console.log(
      color("Capabilities: ") + capabilities.map((c) => chalk.yellow(c)).join(", "),
    );
  }

  console.log(color(`Findings: ${proofCount}`));
  console.log();
}

export function renderFinding(finding: Finding): void {
  console.log();
  console.log(chalk.red.bold("! ") + chalk.white.bold(finding.problem));

  if (finding.evidence) {
    console.log(chalk.gray("  Evidence: ") + chalk.white(finding.evidence));
  }

  if (finding.capabilities && finding.capabilities.length > 0) {
    const tags = finding.capabilities
      .map((c) => chalk.bgYellow.black(` ${c} `))
      .join(" ");
    console.log("  " + tags);
  }

  if (finding.severity) {
    const severityColor =
      finding.severity === "critical"
        ? chalk.red
        : finding.severity === "high"
          ? chalk.yellow
          : chalk.white;
    console.log(chalk.gray("  Severity: ") + severityColor(finding.severity));
  }
}

export function renderPhase(phase: string): string {
  const phaseLabels: Record<string, string> = {
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
