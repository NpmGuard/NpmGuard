import type { Event } from "@npmguard/shared";
import type { ComposedSetup, Manipulation, SetupContext } from "./types.js";

/**
 * Compose a list of manipulation primitives into a single setup plan:
 *  - merge all `envs` (later wins on conflict)
 *  - last-set wins for `ldPreload`, `preload`, `hostname`
 *  - concatenate `volumes`; union `capAdd`
 *  - collect `postStart` hooks in order
 *  - accumulate `applied` fields for the eventual `RunArtifact.setupApplied`
 *  - collect synthetic `events`
 */
export function applyManipulation(primitives: readonly Manipulation[]): ComposedSetup {
  const envs: Record<string, string> = {};
  let ldPreload: string | null = null;
  let preload: string | null = null;
  let hostname: string | null = null;
  const volumes: ComposedSetup["specPatch"]["volumes"] = [];
  const capAdd: string[] = [];
  const postStarts: Array<(ctx: SetupContext) => Promise<void>> = [];
  const events: Event[] = [];

  const applied: ComposedSetup["applied"] = {
    env: {},
    date: null,
    plantFiles: [],
    stubUrls: [],
    hostname: null,
    locale: null,
    patches: [],
    preloadHash: null,
  };

  for (const prim of primitives) {
    if (prim.envs) Object.assign(envs, prim.envs);
    if (prim.ldPreload) ldPreload = prim.ldPreload;
    if (prim.preload) preload = prim.preload;
    if (prim.hostname) hostname = prim.hostname;
    if (prim.volumes) volumes.push(...prim.volumes);
    if (prim.capAdd) capAdd.push(...prim.capAdd);
    if (prim.postStart) postStarts.push(prim.postStart);
    if (prim.events) events.push(...prim.events);

    // Merge `applied` by field. Late-wins for scalar fields; accumulate arrays.
    const a = prim.applied;
    if (a.env) Object.assign(applied.env!, a.env);
    if (a.date !== undefined) applied.date = a.date;
    if (a.plantFiles) applied.plantFiles!.push(...a.plantFiles);
    if (a.stubUrls) applied.stubUrls!.push(...a.stubUrls);
    if (a.hostname !== undefined) applied.hostname = a.hostname;
    if (a.locale !== undefined) applied.locale = a.locale;
    if (a.patches) applied.patches!.push(...a.patches);
    if (a.preloadHash !== undefined) applied.preloadHash = a.preloadHash;
  }

  return {
    specPatch: {
      envs,
      ldPreload,
      preload,
      hostname,
      volumes,
      capAdd: [...new Set(capAdd)],
    },
    postStarts,
    applied,
    events,
  };
}
