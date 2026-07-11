import * as path from "node:path";
import { LIFECYCLE_SCRIPTS } from "./parse-manifest.js";
import type { DealBreaker, EntryPoints, FileRecord, InventoryFlag } from "../models.js";

// Structural facts only — the facts a single source-file read CANNOT see:
// permissions, binary-ness, lifecycle wiring, plus the dealbreakers that
// short-circuit an audit. Content patterns (obfuscation, encoded blobs,
// minification) belong to the FLAG pass, which reads whole file bodies and flags
// them with reasons; duplicating them here as structural checks would be noise.

const SHELL_PIPE_PATTERNS = [
  /curl\s.*\|\s*sh\b/i,
  /curl\s.*\|\s*bash\b/i,
  /wget\s.*\|\s*sh\b/i,
  /wget\s.*\|\s*bash\b/i,
  /curl\s.*\|/,
  /wget\s.*-O.*&&\s*(?:sh|bash|chmod)/,
];

const STANDARD_DOTFILES = new Set([
  ".npmignore", ".gitignore", ".browserslistrc", ".editorconfig",
]);
const STANDARD_DOTFILE_PREFIXES = [".eslintrc", ".prettierrc", ".babelrc"];

// ---------------------------------------------------------------------------
// Dealbreaker checks
// ---------------------------------------------------------------------------

function checkShellPipe(scripts: Record<string, string>): DealBreaker | null {
  for (const [key, value] of Object.entries(scripts)) {
    for (const pattern of SHELL_PIPE_PATTERNS) {
      if (pattern.test(value)) {
        return { check: "shell-pipe", detail: `Script '${key}' contains shell pipe: ${value}` };
      }
    }
  }
  return null;
}

function checkMissingInstallFile(entryPoints: EntryPoints, files: FileRecord[]): DealBreaker | null {
  const filePaths = new Set(files.map((f) => f.path));
  for (const ref of entryPoints.install) {
    if (!filePaths.has(ref)) {
      return {
        check: "missing-install-script",
        detail: `Install script references '${ref}' but file not found in package`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flag checks
// ---------------------------------------------------------------------------

function flagLifecycleScripts(scripts: Record<string, string>): InventoryFlag[] {
  const hooks = Object.keys(scripts).filter((k) => LIFECYCLE_SCRIPTS.has(k));
  if (!hooks.length) return [];
  return [{
    severity: "info",
    check: "lifecycle-scripts",
    detail: `Package declares lifecycle hooks: ${hooks.join(", ")}`,
    file: null,
  }];
}

function flagNonNodeScripts(scripts: Record<string, string>): InventoryFlag[] {
  const flags: InventoryFlag[] = [];
  for (const key of LIFECYCLE_SCRIPTS) {
    const value = scripts[key];
    if (!value) continue;
    const parts = value.trim().split(/\s+/);
    if (!parts.length || parts[0] !== "node") {
      flags.push({
        severity: "warn",
        check: "non-node-script",
        detail: `Lifecycle script '${key}' is not a node command: ${value}`,
        file: null,
      });
    }
  }
  return flags;
}

function flagBinaryFiles(files: FileRecord[]): InventoryFlag[] {
  return files
    .filter((f) => f.isBinary)
    .map((f) => ({
      severity: "warn" as const,
      check: "binary-detected",
      detail: `Binary file detected (${f.binaryType})`,
      file: f.path,
    }));
}

function flagExecutableOutsideBin(files: FileRecord[]): InventoryFlag[] {
  const flags: InventoryFlag[] = [];
  for (const f of files) {
    if (f.path.startsWith("bin/") || f.path.startsWith("bin\\")) continue;
    const mode = parseInt(f.permissions, 8);
    if (mode & 0o111) {
      flags.push({
        severity: "warn",
        check: "executable-outside-bin",
        detail: `File has executable permissions (${f.permissions}) outside bin/`,
        file: f.path,
      });
    }
  }
  return flags;
}

function flagHiddenDotfiles(files: FileRecord[]): InventoryFlag[] {
  const flags: InventoryFlag[] = [];
  for (const f of files) {
    const basename = path.basename(f.path);
    if (!basename.startsWith(".")) continue;
    if (STANDARD_DOTFILES.has(basename)) continue;
    if (STANDARD_DOTFILE_PREFIXES.some((p) => basename.startsWith(p))) continue;
    flags.push({
      severity: "info",
      check: "hidden-dotfile",
      detail: `Non-standard dotfile: ${basename}`,
      file: f.path,
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function runInventoryChecks(
  scripts: Record<string, string>,
  entryPoints: EntryPoints,
  files: FileRecord[],
): { flags: InventoryFlag[]; dealbreaker: DealBreaker | null } {
  // Dealbreakers first
  let dealbreaker = checkShellPipe(scripts);
  if (dealbreaker) return { flags: [], dealbreaker };

  dealbreaker = checkMissingInstallFile(entryPoints, files);
  if (dealbreaker) return { flags: [], dealbreaker };

  // Structural facts a single-file read can't see (the FLAG pass covers content).
  const flags: InventoryFlag[] = [
    ...flagLifecycleScripts(scripts),
    ...flagNonNodeScripts(scripts),
    ...flagBinaryFiles(files),
    ...flagExecutableOutsideBin(files),
    ...flagHiddenDotfiles(files),
  ];

  return { flags, dealbreaker: null };
}
