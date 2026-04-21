import type { Event, FilePatchRef, PlantedFileRef, StubUrlRef } from "@npmguard/shared";
import type { ContainerSpec, VolumeMount } from "../sandbox/container-spec.js";

/**
 * Context passed to a primitive's `postStart` hook.
 * Populated by `runUnderObservation` after the container is launched.
 */
export interface SetupContext {
  runId: string;
  containerName: string;
}

/**
 * The contribution of a single manipulation primitive.
 *
 * Each primitive is a *pure* builder that returns this shape; the composer
 * (`applyManipulation`) merges contributions into the final `ContainerSpec`
 * and runs `postStart` hooks in declaration order after the container starts.
 */
export interface SetupResult {
  /** Env vars to inject into the container via `-e KEY=value`. Merged with later primitives winning on conflict. */
  envs?: Record<string, string>;
  /** `LD_PRELOAD` path inside the container (setDate uses this for libfaketime). Last primitive to set it wins. */
  ldPreload?: string;
  /** Preload script path inside the container for `NODE_OPTIONS=--require`. Last wins. */
  preload?: string;
  /** Hostname override (reserved for geo/analyst-fingerprint manipulation). Last wins. */
  hostname?: string;
  /** Additional volumes to mount. Appended to base spec. */
  volumes?: readonly VolumeMount[];
  /** Capabilities to add. Unioned with base spec. */
  capAdd?: readonly string[];
  /** Hook that runs after `docker run` but before the trigger command. */
  postStart?: (ctx: SetupContext) => Promise<void>;
  /** What to record under `RunArtifact.setupApplied`. Merged by the composer. */
  applied: {
    env?: Record<string, string>;
    date?: string | null;
    plantFiles?: PlantedFileRef[];
    stubUrls?: StubUrlRef[];
    hostname?: string | null;
    locale?: string | null;
    patches?: FilePatchRef[];
    preloadHash?: string | null;
  };
  /** Synthetic engine events to push into `RunArtifact.events` (e.g., setup_bypass). */
  events?: readonly Event[];
}

/** A single primitive or a factory that produces one. Passed to `runUnderObservation.setup`. */
export type Manipulation = SetupResult;

/** Diagnostic output of the composer — consumed by `runUnderObservation`. */
export interface ComposedSetup {
  specPatch: {
    envs: Record<string, string>;
    ldPreload: string | null;
    preload: string | null;
    hostname: string | null;
    volumes: VolumeMount[];
    capAdd: string[];
  };
  postStarts: Array<(ctx: SetupContext) => Promise<void>>;
  applied: NonNullable<SetupResult["applied"]>;
  events: Event[];
}

/** Merge a composed spec patch into a base container spec. */
export function mergeContainerSpec(base: ContainerSpec, patch: ComposedSetup["specPatch"]): ContainerSpec {
  return {
    ...base,
    envs: { ...base.envs, ...patch.envs },
    ldPreload: patch.ldPreload ?? base.ldPreload,
    preload: patch.preload ?? base.preload,
    hostname: patch.hostname ?? base.hostname,
    volumes: [...base.volumes, ...patch.volumes],
    capAdd: [...new Set([...base.capAdd, ...patch.capAdd])],
  };
}
