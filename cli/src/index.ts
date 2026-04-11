#!/usr/bin/env node

import { Command } from "commander";
import { auditCommand } from "./commands/audit.js";
import { checkCommand } from "./commands/check.js";

const program = new Command();

program
  .name("npmguard")
  .description("NpmGuard CLI — audit npm packages for security issues")
  .version("1.0.0")
  .option(
    "--api <url>",
    "NpmGuard engine API URL",
    process.env.NPMGUARD_API_URL ?? "https://npmguard.com",
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
  .command("check")
  .description("Check all dependencies of a project against existing audits")
  .option("--path <dir>", "Path to project directory", ".")
  .action(async (cmdOpts: { path: string }) => {
    const apiUrl = program.opts().api as string;
    await checkCommand({ path: cmdOpts.path, api: apiUrl });
  });

program.parse();
