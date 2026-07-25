import { z } from "zod";
import { VerdictSchema } from "./models.js";

/**
 * Replay — a curated, browsable set of RECORDED real audits (F-I, §5.3).
 * A replay streams on the ordinary audit SSE (`/audit/{id}/events`), so there is
 * one renderer and one fold, not a product one and a test one.
 *
 * WIRE nullability rule as in panel.ts: `.nullable()`, never `.optional()`.
 *
 * Nothing on the engine side emits this yet: today `/demo/*` returns a bare
 * `{packages: string[]}` keyed by package NAME, which cannot express two
 * recordings of the same package or say why one is worth watching.
 */

// One recorded audit in the gallery. Deliberately minimal: everything a card
// needs to be picked, plus the pins that let a stale recording fail loud.
export const ReplayEntrySchema = z.object({
  // Stable identity and permalink (F-I3): /replay/{slug}. NOT the package name —
  // a package can have several recordings (versions, or a clean vs compromised
  // release), and today's name-keyed lookup silently overwrites them.
  slug: z.string(),
  packageName: z.string(),
  version: z.string(),
  // The verdict the recorded audit actually reached. This is the audit-core
  // Verdict (SAFE|DANGEROUS), NOT the panel Outcome: a replay always carries a
  // completed report, and an audit that could not conclude has no report to
  // replay — so there is no ERROR case here.
  verdict: VerdictSchema,
  // Why this one is worth watching (F-I2/F-I5) — e.g. a clean popular package, a
  // confirmed exfil, or a DEFERRED hypothesis where the tool could not prove it.
  // Curated prose, so it is authored with the recording, never derived.
  whyInteresting: z.string(),
  // Wall clock of the ORIGINAL audit. What a viewer waits is this divided by the
  // engine's replay speed knob, so it is a "this was a real N-second audit"
  // claim, not a progress bar.
  durationMs: z.number().int().nonnegative(),
  recordedAt: z.string(),
  // CONTRACT PINS (F-I6). A recording replays events and a report authored
  // against a specific contract; if either has moved, the recording must fail
  // loud rather than play a lie.
  // `reportSchemaVersion` is the report's own version (today: 2, the only
  // versioning a committed recording carries).
  reportSchemaVersion: z.number().int().positive(),
  // The engine build that produced the recording. Nullable because the existing
  // committed recordings do not carry it — an honest null, not a placeholder.
  engineVersion: z.string().nullable(),
});
export type ReplayEntry = z.infer<typeof ReplayEntrySchema>;

// GET /replays — the gallery (F-I2). An empty list must render honestly (an
// audit launcher), never a fake dropdown.
export const ReplayGalleryResponseSchema = z.object({
  replays: z.array(ReplayEntrySchema),
});
export type ReplayGalleryResponse = z.infer<typeof ReplayGalleryResponseSchema>;

// POST /replays/{slug}/start — the returned auditId streams on the ordinary
// audit SSE, which is what makes a replay indistinguishable from a live audit
// (F-I4) for free. Labelling it AS a replay is the caller's job: it knows it
// asked for one.
export const ReplayStartResponseSchema = z.object({
  auditId: z.string(),
  slug: z.string(),
});
export type ReplayStartResponse = z.infer<typeof ReplayStartResponseSchema>;
