import type { PlantedFileRef } from "@npmguard/shared";
import { sha256Hex } from "../evidence/hashing.js";
import { writeFileInContainer } from "./helpers.js";
import type { SetupContext, SetupResult } from "./types.js";

const PRELOAD_PATH = "/tmp/npmguard-preload.js";

/**
 * Inject a Node preload script via `NODE_OPTIONS=--require`. Runs before the
 * package's entrypoint is loaded. Useful for: custom instrumentation, spies
 * that must be in place at require time, polyfills.
 */
export function preload(code: string): SetupResult {
  const hash = sha256Hex(code);
  return {
    preload: PRELOAD_PATH,
    postStart: async (ctx: SetupContext) => {
      await writeFileInContainer(ctx.containerName, PRELOAD_PATH, code);
    },
    applied: { preloadHash: hash },
  };
}

/** Re-export for callers that also use plantFiles. */
export type { PlantedFileRef };
