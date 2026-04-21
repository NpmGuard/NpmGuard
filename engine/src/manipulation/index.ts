// Public surface of the manipulation primitives.
// Each primitive returns a `SetupResult` (see ./types.ts) which the composer
// (./compose.ts) merges into the container launch plan for runUnderObservation.

export type { SetupContext, SetupResult, Manipulation, ComposedSetup } from "./types.js";
export { mergeContainerSpec } from "./types.js";
export { applyManipulation } from "./compose.js";

export { setEnv } from "./env.js";
export { setDate } from "./date.js";
export { preload } from "./preload.js";
export { plantFiles, type PlantFileSpec } from "./plant-files.js";
export { patchFile, type FilePatchSpec } from "./patch-file.js";
export { stubUrl, type StubUrlSpec } from "./stub-url.js";
