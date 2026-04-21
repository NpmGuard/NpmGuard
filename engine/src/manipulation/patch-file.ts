import type { FilePatchRef } from "@npmguard/shared";
import { sha256Hex } from "../evidence/hashing.js";
import { readFileInContainer, writeFileInContainer } from "./helpers.js";
import type { SetupContext, SetupResult } from "./types.js";

export interface FilePatchSpec {
  /** Path relative to the package root (e.g., "index.js", "lib/init.js"). */
  path: string;
  replacements: readonly {
    pattern: string | RegExp;
    replacement: string;
  }[];
}

/**
 * Modify files in the package copy before the trigger runs.
 *
 * The package is copied from the RO source mount (`/pkg-src`) into a
 * writable tmpfs (`/pkg`) at container start, so patches do not touch the
 * host. Each patch is recorded with a content hash (of the normalized
 * pattern/replacement pairs) in `RunArtifact.setupApplied.patches`.
 *
 * Typical use: neutralize anti-debug checks or force a specific branch
 * (e.g., rewrite `if (Date.now() > T)` → `if (true)`).
 */
export function patchFile(patches: readonly FilePatchSpec[]): SetupResult {
  const refs: FilePatchRef[] = patches.map((p) => ({
    path: p.path,
    patchHash: sha256Hex(normalizeForHash(p.replacements)),
  }));

  return {
    postStart: async (ctx: SetupContext) => {
      for (const patch of patches) {
        const absPath = `/pkg/${patch.path}`;
        const original = await readFileInContainer(ctx.containerName, absPath);
        let patched = original;
        for (const { pattern, replacement } of patch.replacements) {
          if (typeof pattern === "string") {
            patched = patched.split(pattern).join(replacement);
          } else {
            patched = patched.replace(new RegExp(pattern.source, pattern.flags), replacement);
          }
        }
        if (patched !== original) {
          await writeFileInContainer(ctx.containerName, absPath, patched);
        }
      }
    },
    applied: { patches: refs },
  };
}

function normalizeForHash(
  replacements: FilePatchSpec["replacements"],
): string {
  const normalized = replacements.map((r) => ({
    pattern:
      r.pattern instanceof RegExp
        ? `re:${r.pattern.source}::${r.pattern.flags}`
        : `str:${r.pattern}`,
    replacement: r.replacement,
  }));
  return JSON.stringify(normalized);
}
