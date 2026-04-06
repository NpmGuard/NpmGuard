import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SOURCE_FILE_TYPES } from "../config.js";
import { CAPABILITY_EXAMPLES } from "./test-gen-prompt.js";

const EXPLOITS_DIR = resolve(import.meta.dirname, "../../../sandbox/exploits");

/** Read all source files from a package directory into a single string for LLM context. */
export function readPackageSource(packagePath: string): string {
  const files: string[] = [];

  function walk(dir: string, prefix: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        const ext = entry.name.split(".").pop() ?? "";
        if (SOURCE_FILE_TYPES.has(ext) || entry.name === "package.json") {
          try {
            const stat = statSync(full);
            if (stat.size < 50_000) {
              files.push(`--- ${rel} ---\n${readFileSync(full, "utf-8")}`);
            }
          } catch { /* skip unreadable */ }
        }
      }
    }
  }

  walk(packagePath, "");
  return files.join("\n\n");
}

/** Read the example exploit test for a given capability. */
export function readExampleTest(capability: string): string {
  const exampleName = CAPABILITY_EXAMPLES[capability] ?? "env-exfil";
  // Try .ts first, fall back to .js
  for (const ext of [".test.ts", ".test.js"]) {
    const p = join(EXPLOITS_DIR, `${exampleName}${ext}`);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  const fallback = join(EXPLOITS_DIR, "env-exfil.test.js");
  return existsSync(fallback) ? readFileSync(fallback, "utf-8") : "";
}
