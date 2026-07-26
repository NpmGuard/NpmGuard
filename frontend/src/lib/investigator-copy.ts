/**
 * The investigation transcript, generated from events.
 *
 * Two rules decide everything in this file.
 *
 * **No model writes interface copy.** Every sentence below is a fixed template
 * keyed by event type and claim kind, filled with values off the wire. That makes
 * the transcript deterministic (the same audit reads identically on every replay,
 * which is what makes a replay a replay), instantly available (no round trip
 * between a frame arriving and a viewer being told what it was), and safe (a
 * model cannot be prompted into writing the UI's own status line).
 *
 * **No hidden reasoning is shown.** The engine publishes observations, plans,
 * actions and judgments. It does not publish chain-of-thought, and nothing here
 * may imply that it does — "thinking…", "the model considered…", a streamed
 * partial thought. What a viewer reads is what the audit RECORDED.
 *
 * Machine actions keep exact structured values; investigator prose is the small
 * fixed vocabulary. The two are distinguishable on screen for a reason: a reader
 * must always be able to tell which words are the product's and which are the
 * run's.
 */

import type { AuditEventUnion, ClaimKind, DisplayObservation, ToolCall } from "@npmguard/shared";

export type TranscriptKind = "narration" | "action" | "observation" | "judgment" | "milestone";

export interface TranscriptEntry {
  /** frame index in the tape — the join back to the event that produced it */
  index: number;
  kind: TranscriptKind;
  text: string;
  /** structured detail rendered as a machine card rather than prose */
  fields?: { label: string; value: string }[];
  hypId?: string;
  file?: string;
}

/**
 * What each claim kind means, in one clause a non-specialist can read.
 *
 * Deliberately phrased as behaviour rather than as a category name: "reads
 * credential-shaped environment variables" tells a reader what to look for in the
 * highlighted lines, where "env_exfil" only tells them the audit has a taxonomy.
 */
const CLAIM_PHRASE: Record<ClaimKind, string> = {
  env_exfil: "reads credential-shaped environment variables and may send them out",
  cred_theft: "reads credential files from the home directory",
  binary_drop: "writes an executable to disk",
  obfuscation: "hides what it does behind encoded or generated code",
  persistence: "installs something that outlives the install",
  destructive: "deletes or overwrites files outside its own package",
  propagation: "reaches for other packages or repositories",
  dos_loop: "spins without terminating",
  clipboard_hijack: "reads or rewrites the clipboard",
  dom_inject: "injects script into pages the host renders",
  telemetry: "reports usage to a remote endpoint",
  dns_exfil: "encodes data into DNS lookups",
  build_plugin_exfil: "hooks the build to reach data the package should not see",
};

const TRIGGER_VERB: Record<string, string> = {
  entrypoint: "Run entrypoint",
  lifecycle: "Run lifecycle hook",
  bin: "Run bin",
  subpath: "Run subpath export",
};

/** A tool call as a machine card: the tool, and the arguments that identify it. */
export function describeToolCall(call: ToolCall): { label: string; value: string } {
  const args = call.args as Record<string, unknown>;
  switch (call.tool) {
    case "setEnv": {
      const keys = Object.keys((args.env as Record<string, unknown>) ?? {});
      return { label: "Plant environment", value: keys.join(", ") || "(none)" };
    }
    case "plantFiles": {
      const files = (args.files as { path?: string }[] | undefined) ?? [];
      return {
        label: "Plant file",
        value: files.map((file) => file.path ?? "?").join(", ") || "(none)",
      };
    }
    case "stubUrl":
      return { label: "Stub endpoint", value: String(args.pattern ?? "") };
    case "setDate":
      return { label: "Freeze clock", value: String(args.date ?? "") };
    case "patchFile":
      return { label: "Patch file", value: String(args.path ?? "") };
    case "preload":
      return { label: "Preload script", value: "injected before the entrypoint" };
    case "trigger":
      return {
        label: TRIGGER_VERB[String(args.kind ?? "")] ?? "Trigger",
        value: String(args.target ?? ""),
      };
    default:
      return { label: call.tool, value: Object.keys(args).join(", ") };
  }
}

/**
 * One observation as a transcript line: `00:183 · network · POST evil.test/x`.
 *
 * The stamp is relative to the run's own start, because that is the only clock a
 * viewer can reason about — an absolute timestamp would be a fact about the
 * machine the sandbox happened to run on.
 */
export function describeObservation(observation: DisplayObservation): string {
  const seconds = Math.floor(observation.atMs / 1000);
  const millis = Math.round(observation.atMs % 1000);
  const stamp = `${String(seconds).padStart(2, "0")}:${String(millis).padStart(3, "0")}`;
  const repeat = observation.occurrences > 1 ? ` ×${observation.occurrences}` : "";
  return `${stamp} · ${observation.kind} · ${observation.summary}${repeat}`;
}

const STATE_VERB = {
  CONFIRMED: "Confirmed",
  REFUTED: "Refuted",
  DEFERRED: "Could not judge",
  OPEN: "Open",
  IN_PROGRESS: "In progress",
} as const;

/**
 * One frame → zero or one transcript entries.
 *
 * Most frames produce nothing, and that is the point: a transcript that narrated
 * every `file_analyzing` would be a log, and the coverage counter already carries
 * that fact without asking anyone to read 400 lines.
 */
export function narrate(event: AuditEventUnion, index: number): TranscriptEntry | null {
  switch (event.type) {
    case "audit_started":
      return { index, kind: "milestone", text: `Auditing ${event.packageName}.` };

    case "intent_extracted":
      return {
        index,
        kind: "narration",
        text: `The package says it ${event.statedPurpose.replace(/\.$/, "")}.`,
      };

    case "file_verdict": {
      if (event.verdict.riskContribution < 3) return null;
      return {
        index,
        kind: "narration",
        file: event.verdict.file,
        text: `\`${event.verdict.file}\` ${event.verdict.summary}`,
      };
    }

    case "hypothesis_emitted":
      return {
        index,
        kind: "narration",
        hypId: event.hypId,
        file: event.focusFiles[0],
        text: `Suspecting that \`${event.focusFiles[0] ?? "this package"}\` ${CLAIM_PHRASE[event.claim]}.`,
        fields: event.focusLines.map((range) => ({
          label: "Lines",
          value: `${range.file}:${range.range}`,
        })),
      };

    case "experiment_started":
      return {
        index,
        kind: "action",
        hypId: event.hypId,
        text: "Testing it by making the suspected code run under observation.",
        fields: [
          ...event.experiment.map(describeToolCall),
          {
            label: TRIGGER_VERB[event.trigger.kind] ?? "Trigger",
            value: event.trigger.target,
          },
        ],
      };

    case "sandbox_started":
      return {
        index,
        kind: "action",
        hypId: event.hypId,
        text: "Sandbox running under the full oracle.",
        fields: [
          {
            label: "Observing",
            value: Object.entries(event.observe)
              .filter(([, on]) => on)
              .map(([sensor]) => sensor)
              .join(", "),
          },
          { label: "Budget", value: `${Math.round(event.budget.wallMs / 1000)}s wall clock` },
        ],
      };

    case "sandbox_completed": {
      const run = event.run;
      const outcome = run.error
        ? `${run.error.kind}: ${run.error.detail}`
        : run.timedOut
          ? "hit its wall-clock budget"
          : `exited ${run.exitCode}`;
      return {
        index,
        kind: "observation",
        hypId: event.hypId,
        text: `Run finished — ${outcome}.`,
        fields: [
          { label: "Duration", value: `${Math.round(run.wallMs)}ms` },
          { label: "Events", value: String(run.eventCount) },
          ...(run.omittedObservationCount > 0
            ? [
                {
                  label: "Shown",
                  value: `${run.observations.length} of ${run.observations.length + run.omittedObservationCount}`,
                },
              ]
            : []),
        ],
      };
    }

    case "judgment_started":
      return {
        index,
        kind: "action",
        hypId: event.hypId,
        text: "Weighing the recorded evidence against the hypothesis.",
      };

    case "hypothesis_resolved": {
      const cited = event.citedEventIds.length
        ? ` Cited ${event.citedEventIds.join(", ")}.`
        : "";
      return {
        index,
        kind: "judgment",
        hypId: event.hypId,
        text: `${STATE_VERB[event.state]}: ${event.reason}${cited}`,
        fields: event.citedObservations.map((observation) => ({
          label: observation.eventId,
          value: describeObservation(observation),
        })),
      };
    }

    case "verdict_reached":
      return {
        index,
        kind: "milestone",
        text:
          event.verdict === "DANGEROUS"
            ? `DANGEROUS — ${event.confirmedCount} confirmed ${event.confirmedCount === 1 ? "hypothesis" : "hypotheses"} with cited evidence.`
            : "SAFE — no confirmed threat found. Not a proof of absence.",
      };

    case "audit_error":
      return {
        index,
        kind: "milestone",
        text: `Could not conclude — ${event.error}`,
      };

    default:
      return null;
  }
}

/** The whole transcript for a tape prefix. Pure; recomputed on seek. */
export function transcriptFor(
  frames: readonly AuditEventUnion[],
  count: number,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < Math.min(count, frames.length); index += 1) {
    const entry = narrate(frames[index], index);
    if (entry) entries.push(entry);
  }
  return entries;
}
