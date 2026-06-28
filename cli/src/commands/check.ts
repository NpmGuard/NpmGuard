import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import chalk from "chalk";
import * as api from "../api.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function checkCommand(opts: {
  path: string;
  api: string;
}): Promise<void> {
  const apiUrl = opts.api;
  const pkgPath = resolve(opts.path, "package.json");

  // 1. Read package.json
  let pkgJson: PackageJson;
  try {
    const raw = await readFile(pkgPath, "utf-8");
    pkgJson = JSON.parse(raw) as PackageJson;
  } catch (err) {
    console.error(
      chalk.red(`Failed to read ${pkgPath}: `) +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }

  // 2. Collect dependency names
  const deps = new Set<string>([
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.devDependencies ?? {}),
  ]);

  if (deps.size === 0) {
    console.log(chalk.yellow("No dependencies found in package.json."));
    return;
  }

  console.log(chalk.bold(`Checking ${deps.size} dependencies...\n`));

  // 3. Check each dependency
  const results: Array<{
    name: string;
    version: string;
    verdict: string | null;
  }> = [];

  for (const name of deps) {
    const versionSpec =
      pkgJson.dependencies?.[name] ?? pkgJson.devDependencies?.[name] ?? "";
    try {
      const res = await api.getPackageReport(apiUrl, name);
      const inner = (res as { report?: { verdict?: string; version?: string } } | null)
        ?.report;
      results.push({
        name,
        version:
          (res as { version?: string } | null)?.version ??
          inner?.version ??
          versionSpec,
        verdict:
          inner?.verdict ??
          (res as { verdict?: string } | null)?.verdict ??
          null,
      });
    } catch {
      results.push({ name, version: versionSpec, verdict: null });
    }
  }

  // 4. Print summary table
  const nameWidth = Math.max(12, ...results.map((r) => r.name.length)) + 2;
  const versionWidth = Math.max(10, ...results.map((r) => r.version.length)) + 2;

  const header =
    chalk.bold("Package".padEnd(nameWidth)) +
    chalk.bold("Version".padEnd(versionWidth)) +
    chalk.bold("Verdict");
  console.log(header);
  console.log("─".repeat(nameWidth + versionWidth + 12));

  for (const r of results) {
    const nameCol = r.name.padEnd(nameWidth);
    const versionCol = r.version.padEnd(versionWidth);

    let verdictCol: string;
    if (r.verdict === null) {
      verdictCol = chalk.gray("not audited");
    } else if (r.verdict.toUpperCase() === "SAFE") {
      verdictCol = chalk.green("SAFE");
    } else if (r.verdict.toUpperCase() === "DANGEROUS") {
      verdictCol = chalk.red("DANGEROUS");
    } else {
      verdictCol = chalk.yellow(r.verdict);
    }

    console.log(nameCol + versionCol + verdictCol);
  }

  console.log();

  // Count stats
  const safe = results.filter(
    (r) => r.verdict?.toUpperCase() === "SAFE",
  ).length;
  const dangerous = results.filter(
    (r) => r.verdict?.toUpperCase() === "DANGEROUS",
  ).length;
  const notAudited = results.filter((r) => r.verdict === null).length;

  console.log(
    chalk.green(`${safe} safe`) +
      " | " +
      chalk.red(`${dangerous} dangerous`) +
      " | " +
      chalk.gray(`${notAudited} not audited`),
  );
}
