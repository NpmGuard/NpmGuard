#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { auditCommand } from "./commands/audit.js";
import { checkCommand } from "./commands/check.js";
import { installCommand } from "./commands/install.js";

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("npmguard")
  .description("NpmGuard CLI — audit npm packages for security issues")
  .version(readPackageVersion())
  .option(
    "--api <url>",
    "NpmGuard engine API URL",
    process.env.NPMGUARD_API_URL ?? "https://npmguard.com",
  )
  .option(
    "--web <url>",
    "NpmGuard web app URL for browser wallet payments",
    process.env.NPMGUARD_WEB_URL ?? "https://npmguard.com",
  );

program
  .command("audit")
  .description("Pay for and run a security audit on an npm package")
  .argument("<package>", "Package name, optionally with version (e.g. express@4.18.0)")
  .action(async (pkg: string) => {
    const apiUrl = program.opts().api as string;
    await auditCommand(pkg, { api: apiUrl });
  });

program
  .command("install")
  .description("Install an npm package with NpmGuard security check")
  .argument("<package>", "Package name, optionally with version (e.g. express@4.18.0)")
  .option("-f, --force", "Install even if the package is flagged as dangerous")
  .action(async (pkg: string, cmdOpts: { force?: boolean }) => {
    const opts = program.opts() as { api: string; web: string };
    await installCommand(pkg, { api: opts.api, web: opts.web, force: cmdOpts.force });
  });

program
  .command("check")
  .description("Check all dependencies of a project against existing audits")
  .option("--path <dir>", "Path to project directory", ".")
  .action(async (cmdOpts: { path: string }) => {
    const apiUrl = program.opts().api as string;
    await checkCommand({ path: cmdOpts.path, api: apiUrl });
  });

program.parse();
