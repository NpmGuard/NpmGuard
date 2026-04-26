import type { InstrumentationLog, NetworkCall, FsOperation, ProcessSpawn, EvalCall, CryptoOp, TimerRecord } from "../models.js";

// ---------------------------------------------------------------------------
// Parse the raw trace events emitted by INSTRUMENTATION_JS at process exit.
// The script writes them as a JSON array of `{ type, ... }` records inside
// `__NPMGUARD_TRACE__ ... __NPMGUARD_TRACE_END__` markers. Each entry's
// shape depends on its `type` (see sandbox/instrumentation.ts).
// ---------------------------------------------------------------------------

const TRACE_START = "__NPMGUARD_TRACE__";
const TRACE_END = "__NPMGUARD_TRACE_END__";

interface RawEvent {
  type: string;
  [key: string]: unknown;
}

function emptyLog(): InstrumentationLog {
  return {
    modulesLoaded: [],
    networkCalls: [],
    fsOperations: [],
    envAccess: [],
    processSpawns: [],
    evalCalls: [],
    cryptoOps: [],
    timers: [],
  };
}

/** Extract every `__NPMGUARD_TRACE__…__NPMGUARD_TRACE_END__` block from a raw
 *  blob (typically a tool-call result preview) and return their parsed event
 *  arrays concatenated. Malformed blocks are skipped silently. */
export function extractTraceBlocks(blob: string): RawEvent[] {
  if (!blob) return [];
  const events: RawEvent[] = [];
  let cursor = 0;
  while (true) {
    const start = blob.indexOf(TRACE_START, cursor);
    if (start === -1) break;
    const end = blob.indexOf(TRACE_END, start + TRACE_START.length);
    if (end === -1) break;
    const json = blob.slice(start + TRACE_START.length, end).trim();
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry === "object" && typeof entry.type === "string") {
            events.push(entry as RawEvent);
          }
        }
      }
    } catch {
      // Tolerate truncated or partial blocks — they happen when output is
      // capped at MAX_OUTPUT_BYTES in the sandbox controller.
    }
    cursor = end + TRACE_END.length;
  }
  return events;
}

/** Aggregate raw events into the typed InstrumentationLog shape, deduplicating
 *  on a per-event basis to keep the report tight. */
export function aggregateTraceEvents(events: RawEvent[]): InstrumentationLog {
  const log = emptyLog();
  const modulesSeen = new Set<string>();
  const envSeen = new Set<string>();
  const networkSeen = new Set<string>();
  const fsSeen = new Set<string>();
  const processSeen = new Set<string>();
  const evalSeen = new Set<string>();
  const cryptoSeen = new Set<string>();
  const timerSeen = new Set<string>();

  for (const e of events) {
    switch (e.type) {
      case "require": {
        const mod = String(e.module ?? "");
        if (mod && !modulesSeen.has(mod)) {
          modulesSeen.add(mod);
          log.modulesLoaded.push(mod);
        }
        break;
      }
      case "network": {
        const call: NetworkCall = {
          method: String(e.method ?? "GET"),
          url: String(e.url ?? ""),
          bodyPreview: typeof e.body === "string" ? e.body.slice(0, 200) : "",
        };
        const key = `${call.method} ${call.url}`;
        if (!networkSeen.has(key)) {
          networkSeen.add(key);
          log.networkCalls.push(call);
        }
        break;
      }
      case "fs": {
        const op: FsOperation = {
          op: String(e.method ?? ""),
          path: String(e.path ?? ""),
          preview: "",
        };
        const key = `${op.op}:${op.path}`;
        if (!fsSeen.has(key)) {
          fsSeen.add(key);
          log.fsOperations.push(op);
        }
        break;
      }
      case "env": {
        const key = String(e.key ?? "");
        if (key && !envSeen.has(key)) {
          envSeen.add(key);
          log.envAccess.push(key);
        }
        break;
      }
      case "process": {
        const cmd = String(e.cmd ?? "");
        const args = Array.isArray(e.args) ? e.args.map(String) : [];
        const spawn: ProcessSpawn = { cmd, args };
        const key = `${cmd} ${args.join(" ")}`;
        if (!processSeen.has(key)) {
          processSeen.add(key);
          log.processSpawns.push(spawn);
        }
        break;
      }
      case "eval": {
        const code = String(e.code ?? "");
        const call: EvalCall = { code };
        if (code && !evalSeen.has(code)) {
          evalSeen.add(code);
          log.evalCalls.push(call);
        }
        break;
      }
      case "crypto": {
        const op: CryptoOp = {
          method: String(e.method ?? ""),
          algo: String(e.algo ?? ""),
        };
        const key = `${op.method}:${op.algo}`;
        if (!cryptoSeen.has(key)) {
          cryptoSeen.add(key);
          log.cryptoOps.push(op);
        }
        break;
      }
      case "timer": {
        const rec: TimerRecord = {
          type: String(e.kind ?? ""),
          ms: Number(e.ms ?? 0),
          source: "",
        };
        const key = `${rec.type}:${rec.ms}`;
        if (!timerSeen.has(key)) {
          timerSeen.add(key);
          log.timers.push(rec);
        }
        break;
      }
    }
  }

  return log;
}

/** Convenience: walk a list of tool-call result previews, concat all trace
 *  blocks, and return the aggregated log. Returns null when there is nothing
 *  to report so callers can keep `runtimeEvidence` truly absent. */
export function aggregateFromResultPreviews(previews: string[]): InstrumentationLog | null {
  const events: RawEvent[] = [];
  for (const preview of previews) {
    events.push(...extractTraceBlocks(preview));
  }
  if (events.length === 0) return null;
  const log = aggregateTraceEvents(events);
  // If aggregation produced nothing (only unrecognized events), drop it.
  const total =
    log.modulesLoaded.length +
    log.networkCalls.length +
    log.fsOperations.length +
    log.envAccess.length +
    log.processSpawns.length +
    log.evalCalls.length +
    log.cryptoOps.length +
    log.timers.length;
  return total > 0 ? log : null;
}
