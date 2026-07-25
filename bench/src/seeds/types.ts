import { z } from "zod";

// ---------------------------------------------------------------------------
// Seed-corpus types.
//
// The SEED CATALOGUE's shape, and nothing about MEASUREMENT: scoring lives in
// `engine/npmguard/bench/` and is derived from a report at read time, never from
// a stored capability subset or proof kind.
//
// This exists because the catalogue itself is curated material with locked SRI
// hashes (`src/seeds/catalog.ts`): 28 npm packages, each pinned to a published
// sha512. Mutation testing is DEFERRED to a future dataset version rather than
// abandoned, and re-locking the catalogue means re-fetching every tarball — so
// the lock/fetch/verify-loads trio stays runnable. `Difficulty` is deliberately
// absent: it is a mutation-testing field with no producer.
// ---------------------------------------------------------------------------

/** A behavioural profile of the unmutated seed. Used to ask questions like
 *  "did recall on env-exfil mutations differ between packages that already use
 *  the network legitimately?". */
export const SeedProfile = z.object({
  network: z.boolean(),
  fs: z.boolean(),
  crypto: z.boolean(),
  spawn: z.boolean(),
  /** Has a postinstall / preinstall / install / prepare script in package.json. */
  lifecycleScripts: z.boolean(),
});
export type SeedProfile = z.infer<typeof SeedProfile>;

/** Hosting form — affects whether runtime instrumentation can hook in. */
export const SeedForm = z.enum(["cjs", "esm", "dual", "native-binding"]);
export type SeedForm = z.infer<typeof SeedForm>;

export const Seed = z.object({
  /** npm package name, exactly as published. */
  name: z.string(),
  /** Exact version pinned for reproducibility. */
  version: z.string(),
  /** SRI string `sha512-<base64>` — populated by the lock script. Empty
   *  initially; the fetcher refuses to proceed if any seed has empty
   *  integrity, forcing an explicit lock pass. */
  integrity: z.string(),
  form: SeedForm,
  profile: SeedProfile,
  /** Free-form tags for slicing the corpus during analysis. */
  tags: z.array(z.string()).default([]),
  description: z.string(),
});
export type Seed = z.infer<typeof Seed>;

export const SeedCatalog = z.array(Seed);
export type SeedCatalog = z.infer<typeof SeedCatalog>;
