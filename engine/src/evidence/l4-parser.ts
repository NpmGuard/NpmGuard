import type { Event, EventKind } from "@npmguard/shared";

const START_MARKER = "__NPMGUARD_TRACE__";
const END_MARKER = "__NPMGUARD_TRACE_END__";

/** Raw shape emitted by engine/src/sandbox/instrumentation.ts */
interface L4RawEntry {
  type: "require" | "fs" | "network" | "process" | "env" | "eval" | "crypto" | "timer" | "script";
  [key: string]: unknown;
}

/**
 * Parse the L4 monkey-patch trace JSON embedded in stdout. Returns null if
 * the markers are absent (the run may have crashed before exit, or the
 * instrumentation may have been tampered with).
 *
 * Marker search uses `lastIndexOf` to defeat trivial injection of fake
 * markers earlier in the stream: the real trace is the one emitted at
 * process exit, which is the last thing written to stdout.
 */
export function parseL4Trace(stdout: string): Event[] | null {
  const endIdx = stdout.lastIndexOf(END_MARKER);
  if (endIdx === -1) return null;

  const startIdx = stdout.lastIndexOf(START_MARKER, endIdx - 1);
  if (startIdx === -1) return null;

  const json = stdout.slice(startIdx + START_MARKER.length, endIdx);
  let raw: L4RawEntry[];
  try {
    raw = JSON.parse(json) as L4RawEntry[];
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  return raw.map((entry, index) => toEvent(entry, index));
}

function toEvent(entry: L4RawEntry, index: number): Event {
  return {
    // Both layers ride this one trace; a `script` entry comes from the in-process
    // V8 inspector, everything else from the monkey-patch.
    stream: entry.type === "script" ? "L4:v8inspector" : "L4:monkey",
    timestamp: index,          // logical index — these events carry no wall-clock
    pid: 0,                    // single-process
    kind: mapKind(entry.type),
    raw: entry,
    normalized: normalizeEntry(entry),
  };
}

function mapKind(type: L4RawEntry["type"]): EventKind {
  switch (type) {
    case "require": return "require";
    case "fs":      return "fs_op";
    case "network": return "network";
    case "process": return "process";
    case "env":     return "env_access";
    case "eval":    return "eval";
    case "crypto":  return "crypto";
    case "timer":   return "timer";
    case "script":  return "script_parsed";
  }
}

function normalizeEntry(entry: L4RawEntry): Record<string, unknown> {
  switch (entry.type) {
    case "require":
      return { module: String(entry.module ?? ""), from: String(entry.from ?? "") };
    case "fs":
      return { method: String(entry.method ?? ""), path: String(entry.path ?? "") };
    case "network":
      return { method: String(entry.method ?? "GET"), url: String(entry.url ?? "") };
    case "process":
      return { method: String(entry.method ?? ""), cmd: String(entry.cmd ?? "") };
    case "env":
      return { key: String(entry.key ?? "") };
    case "eval":
      return { code: String(entry.code ?? "").slice(0, 200) };
    case "crypto":
      return { method: String(entry.method ?? ""), algo: String(entry.algo ?? "") };
    case "timer":
      return { kind: String(entry.kind ?? ""), ms: Number(entry.ms ?? 0) };
    case "script":
      return { url: String(entry.url ?? ""), source: String(entry.source ?? ""), len: Number(entry.len ?? 0) };
  }
}
