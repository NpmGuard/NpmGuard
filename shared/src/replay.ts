import { z } from "zod";
import { VerdictSchema } from "./models.js";

/**
 * Replay — the browsable index of audits that already ran.
 *
 * There is no recording step and no curation step. `stream_events` holds every
 * frame the engine emitted, keyed by audit, and `GET /audit/{id}/events` already
 * replays it from `seq` 0 for a terminal session. So a replay is not an artifact
 * that has to be produced: it is an audit that finished, and this list is the
 * only thing that was missing to reach one.
 *
 * That is why nothing here is authored. Every field is read back off the audit
 * row or its stored report, so the gallery cannot say something the run did not.
 *
 * WIRE nullability rule as in panel.ts: `.nullable()`, never `.optional()`.
 */

// One finished audit, as a gallery card needs it.
export const ReplayEntrySchema = z.object({
  // The permalink, and the reason this is keyed on an audit rather than on a
  // package: `data/reports/{name}/{version}.json` keeps only the LAST audit of a
  // pair, so a `(name, version)` link silently changes what it points at after a
  // re-audit. `audit_sessions` keeps every run, and this id addresses one.
  auditId: z.string(),
  packageName: z.string(),
  // The concrete version the audit actually resolved, off the stored report.
  // Nullable because an audit can finish without one (a local fixture never
  // resolves a registry version) — an honest null, not a guess.
  version: z.string().nullable(),
  // The audit-core Verdict (SAFE|DANGEROUS), not the panel Outcome. An audit
  // that could not conclude is `error` and has no report, so it is not listed
  // here at all and there is no ERROR case to carry.
  verdict: VerdictSchema,
  // Wall clock of the original run. What a viewer waits is unrelated — replay
  // re-emits stored frames — so this is a "this was a real N-second audit"
  // claim, never a progress bar.
  durationMs: z.number().int().nonnegative(),
  recordedAt: z.string(),
  // The replay vocabulary this audit's stream announced, read off its own
  // `audit_started` frame. Below `REPLAY_FORMAT` the run carries no experiment,
  // sandbox or judgment frames, so there is no investigation to animate — the
  // gallery says which rows play and which open as a static report, rather than
  // letting somebody find out by clicking.
  //
  // An audit that predates the stamp reports 1. Defaulting it FORWARD would make
  // every archived run claim to be animatable, which is the one thing this field
  // exists to prevent.
  replayVersion: z.number().int().positive(),
});
export type ReplayEntry = z.infer<typeof ReplayEntrySchema>;

// GET /replays — newest first. An empty list must render honestly (an audit
// launcher), never a fake row.
export const ReplayGalleryResponseSchema = z.object({
  replays: z.array(ReplayEntrySchema),
});
export type ReplayGalleryResponse = z.infer<typeof ReplayGalleryResponseSchema>;
