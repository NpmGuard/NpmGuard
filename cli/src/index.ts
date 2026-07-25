#!/usr/bin/env node

import { Command } from "commander";
import { attestCommand } from "./commands/attest.js";
import { auditCommand } from "./commands/audit.js";
import { checkCommand } from "./commands/check.js";
import { installCommand } from "./commands/install.js";

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
  .command("install")
  .description("Install an npm package with NpmGuard security check")
  .argument("<package>", "Package name, optionally with version (e.g. express@4.18.0)")
  .option("-f, --force", "Install even if the package is flagged as dangerous")
  .option(
    "--chain <name>",
    "Settlement chain for on-chain payment (e.g. base-sepolia, 0g-testnet)",
  )
  .action(async (pkg: string, cmdOpts: { force?: boolean; chain?: string }) => {
    const apiUrl = program.opts().api as string;
    await installCommand(pkg, {
      api: apiUrl,
      force: cmdOpts.force,
      chain: cmdOpts.chain,
    });
  });

program
  .command("attest")
  .description("Prove a human published this release (World ID)")
  .argument("<package>", "Package with version (e.g. lodash@4.17.21)")
  .option("--no-open", "Print the URL instead of opening a browser")
  .action(async (pkg: string, cmdOpts: { open?: boolean }) => {
    const apiUrl = program.opts().api as string;
    await attestCommand(pkg, { api: apiUrl, noOpen: cmdOpts.open === false });
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
