import type { PlantedFileRef } from "@npmguard/shared";
import { sha256Hex } from "../evidence/hashing.js";
import { writeFileInContainer } from "./helpers.js";
import type { SetupContext, SetupResult } from "./types.js";

export interface PlantFileSpec {
  /** Absolute path inside the container (e.g., "/home/node/.npmrc"). */
  path: string;
  content: string | Buffer;
}

/**
 * Seed fake credential files or any other file into the container's filesystem
 * before the trigger runs. Paths are absolute inside the container — no `~`
 * expansion, so callers explicitly target `/home/node/.npmrc` / `/home/node/.ssh/id_rsa`
 * etc. Content hashes are recorded in `RunArtifact.setupApplied.plantFiles`.
 */
export function plantFiles(specs: readonly PlantFileSpec[]): SetupResult {
  const refs: PlantedFileRef[] = specs.map((s) => ({
    path: s.path,
    contentHash: sha256Hex(typeof s.content === "string" ? s.content : s.content),
  }));

  return {
    postStart: async (ctx: SetupContext) => {
      for (const spec of specs) {
        await writeFileInContainer(ctx.containerName, spec.path, spec.content);
      }
    },
    applied: { plantFiles: refs },
  };
}
