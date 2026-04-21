import type { SetupResult } from "./types.js";

/**
 * Inject arbitrary env vars into the sandbox container via `docker run -e`.
 * The values are recorded verbatim in `RunArtifact.setupApplied.env`.
 */
export function setEnv(envs: Record<string, string>): SetupResult {
  const copy = { ...envs };
  return {
    envs: copy,
    applied: { env: copy },
  };
}
