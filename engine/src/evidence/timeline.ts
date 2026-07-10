import type { Event, RunArtifact } from "@npmguard/shared";

// ---------------------------------------------------------------------------
// Execution timeline — turn a RunArtifact into a readable, chronological,
// layer-tagged trace of what the package actually did. This is the whitebox
// the judge reads instead of a pile of predicate booleans.
//
// The one bit of rendering intelligence is fd resolution: an L1 `write(5,…)`
// carries only a number, so we walk the syscalls in order, bind `fd → target`
// on `openat`/`connect`, and look it up at the matching `read`/`write`. That
// single mechanism is what makes a stdout write render `write stdout` and a
// credential read render `read ~/.npmrc` — the same distinction a human makes,
// and the reason no `persistence`-style predicate is needed to avoid the
// stdout false positive.
//
// Everything else is plain formatting: `id · t+Ns · [layer] · verb · target`,
// sorted by each event's own timestamp (best-effort across sensors — L1/L2 are
// real ns, L3 is mtime-coarse, L4 is a logical index; we do not reconcile the
// clocks). No classification, no per-claim logic. The reader localizes.
// ---------------------------------------------------------------------------

export interface RenderedTimeline {
  /** The full markdown-ish timeline text handed to the judge and persisted. */
  text: string;
  /** The set of emitted event ids (e1..eN) — the judge's citations must exist here. */
  ids: Set<string>;
}

const MAX_TARGET = 100;

export function renderTimeline(artifact: RunArtifact): RenderedTimeline {
  const home = artifact.setupApplied.env.HOME || "/home/node";
  const short = (p: string) => trunc(tilde(p, home));

  // Two clock domains, kept as separate blocks rather than fake-merged: [L4]
  // node-level calls carry only a logical index (no clock), so they're one
  // ordered block; [L1]/[L2]/[L3] carry real-ish timestamps, so they interleave
  // by t+. An [L4] `net` and its [L1] `connect` are the same act seen twice.
  const sorted = (predicate: (e: Event) => boolean): Event[] =>
    artifact.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => predicate(e))
      .sort((a, b) => a.e.timestamp - b.e.timestamp || a.i - b.i)
      .map(({ e }) => e);
  const nodeEvents = sorted((e) => e.stream.startsWith("L4"));
  const clockEvents = sorted((e) => !e.stream.startsWith("L4"));

  // fd → { readable target, is it a socket }. Bindings accrue as we walk
  // openat/connect in order, so a later read/write resolves its fd. The socket
  // flag matters because fds get recycled: a closed file's number is reused for
  // a socket, so a socket op (connect/send) on a file-kind fd means the file
  // binding is stale — render it as a socket, never the old path.
  const fds = new Map<number, { target: string; socket: boolean }>([
    [0, { target: "stdin", socket: false }],
    [1, { target: "stdout", socket: false }],
    [2, { target: "stderr", socket: false }],
  ]);
  const resolveFd = (fd: number | null): string =>
    fd === null ? "fd:?" : fds.get(fd)?.target ?? `fd:${fd}`;

  // Describe every event first (this is where fd resolution mutates `fds`, so
  // it must run in order), then collapse runs of the *same* rendered call that
  // occur back-to-back into one line with a [xN] count — noise like a burst of
  // identical reads becomes one readable row.
  const describeAll = (events: Event[], clock: boolean): Row[] =>
    events.map((e) => {
      const { verb, target } = describe(e, short, resolveFd, fds);
      return { tag: clock ? layerTag(e) : "", verb, target, ts: clock ? e.timestamp : null };
    });
  const nodeRuns = collapse(describeAll(nodeEvents, false));
  const clockRuns = collapse(describeAll(clockEvents, true));

  const ids = new Set<string>();
  let n = 0;
  const nextId = (): string => {
    const id = `e${++n}`;
    ids.add(id);
    return id;
  };
  const times = (c: number): string => (c > 1 ? `  [x${c}]` : "");

  // [L4] first (no t+, no per-line tag — the header carries it); then wall-clock.
  const nodeLines = nodeRuns.map((r) =>
    [nextId().padEnd(5), r.verb.padEnd(8), r.target + times(r.count)].join(" ").trimEnd(),
  );
  const clockLines = clockRuns.map((r) => {
    // A collapsed run shows start-end only when the two stamps actually differ;
    // otherwise one stamp (a burst inside the same 10ms tick isn't a "span").
    const a = sec(r.ts ?? 0);
    const b = r.lastTs === null ? a : sec(r.lastTs);
    const t = r.count > 1 && b !== a ? `t+${a}-${b}s` : `t+${a}s`;
    return [nextId().padEnd(5), t.padEnd(13), `[${r.tag}]`.padEnd(4), r.verb.padEnd(8), r.target + times(r.count)]
      .join(" ")
      .trimEnd();
  });

  const body = n === 0 ? ["", "(no events captured)"] : [
    ...section("[L4] node calls — logical order, no clock", nodeLines),
    ...section("wall-clock t+ — [L1] syscall · [L2] network · [L3] fs-diff (mtime-coarse)", clockLines),
  ];
  return { text: [...header(artifact, short), ...body].join("\n"), ids };
}

/** One rendered call before id assignment. ts is null for the clockless [L4] block. */
interface Row {
  tag: string;
  verb: string;
  target: string;
  ts: number | null;
}

/** Merge back-to-back rows with identical (tag, verb, target); keep count + first/last ts. */
function collapse(rows: Row[]): Array<Row & { count: number; lastTs: number | null }> {
  const out: Array<Row & { count: number; lastTs: number | null }> = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.tag === r.tag && prev.verb === r.verb && prev.target === r.target) {
      prev.count += 1;
      prev.lastTs = r.ts;
    } else {
      out.push({ ...r, count: 1, lastTs: r.ts });
    }
  }
  return out;
}

// ── header + sections ─────────────────────────────────────────────────────────

/** A titled block of lines, or nothing if the block is empty. */
function section(title: string, lines: string[]): string[] {
  return lines.length ? ["", `── ${title} ──`, ...lines] : [];
}

function header(a: RunArtifact, short: (p: string) => string): string[] {
  const t = a.triggerUsed;
  const envKeys = Object.keys(a.setupApplied.env);
  const planted = a.setupApplied.plantFiles.map((f) => short(f.path));
  const setup = [
    envKeys.length ? `env ${envKeys.join(", ")}` : "",
    planted.length ? `planted ${planted.join(", ")}` : "",
  ].filter(Boolean);

  const out = [
    `# Timeline — ${a.runId} · trigger=${t.kind}:${t.target}`,
    `# setup: ${setup.length ? setup.join(" · ") : "(none)"}`,
  ];
  if (a.timedOut) out.push(`# note: run hit the wall-clock budget (timed out)`);
  if (a.error) out.push(`# note: run error — ${a.error.kind}: ${a.error.detail}`);
  return out;
}

// ── per-event rendering ───────────────────────────────────────────────────────

/**
 * Map one event to a `verb` + readable `target`. The only stateful part is fd
 * resolution: openat/connect bind an fd here so a later read/write can name it.
 */
function describe(
  e: Event,
  short: (p: string) => string,
  resolveFd: (fd: number | null) => string,
  fds: Map<number, { target: string; socket: boolean }>,
): { verb: string; target: string } {
  const n = e.normalized ?? {};
  switch (e.kind) {
    // L1 kernel syscalls
    case "openat": {
      const path = short(str(n.path));
      const fd = int(n.ret);
      if (fd !== null && fd >= 0) fds.set(fd, { target: path, socket: false });
      return { verb: "open", target: path };
    }
    case "read":
      return { verb: "read", target: resolveFd(l1Fd0(e.raw)) };
    case "write":
      return { verb: "write", target: resolveFd(l1Fd0(e.raw)) };
    case "connect": {
      // A connect proves its fd is a socket — bind it so a later send/read/write
      // resolves to the peer, and so a recycled file fd stops rendering its old path.
      const fd = l1Fd0(e.raw);
      const target = n.addr ? `${str(n.addr)}:${n.port ?? "?"}` : "socket";
      if (fd !== null) fds.set(fd, { target, socket: true });
      return { verb: "connect", target };
    }
    case "sendto": {
      const fd = l1Fd0(e.raw);
      if (n.addr) {
        const target = `${str(n.addr)}:${n.port ?? "?"}`;
        if (fd !== null) fds.set(fd, { target, socket: true });
        return { verb: "send", target };
      }
      // No peer in the args: use the fd's socket binding if it has one; a
      // file-kind binding here is stale (you can't send on a file) → "socket".
      const entry = fd === null ? undefined : fds.get(fd);
      return { verb: "send", target: entry?.socket ? entry.target : "socket" };
    }
    case "execve":
      return { verb: "exec", target: `${short(str(n.path))} ${argv(n.argv)}`.trimEnd() };
    case "clone":
      return { verb: "clone", target: "" };
    case "unlink":
      return { verb: "unlink", target: short(str(n.path)) };
    case "rename":
    case "link":
      return { verb: e.kind, target: `${short(str(n.from))} → ${short(str(n.to))}` };

    // L2 network capture — the pcap sensor always fills `normalized`.
    case "dns_query":
      return { verb: "dns", target: str(n.dns) };
    case "http_request":
      return { verb: "http", target: `${str(n.method) || "GET"} ${str(n.host)}${str(n.uri)}`.trim() };
    case "tls_sni":
      return { verb: "tls", target: str(n.sni) };
    case "tcp_syn":
      return { verb: "tcp", target: str(n.host) };

    // L3 filesystem diff
    case "file_created":
      return { verb: "create", target: short(str(n.path)) };
    case "file_modified":
      return { verb: "modify", target: short(str(n.path)) };
    case "file_deleted":
      return { verb: "delete", target: short(str(n.path)) };

    // L4 monkey-patch — the semantic layer, already carrying its target
    case "require":
      return { verb: "require", target: str(n.module) };
    case "env_access":
      return { verb: "env", target: str(n.key) };
    case "fs_op":
      return { verb: "fs", target: `${short(str(n.path))} (${str(n.method)})`.trim() };
    case "network":
      return { verb: "net", target: `${str(n.method) || "GET"} ${short(str(n.url))}`.trim() };
    case "process":
      return { verb: "spawn", target: short(str(n.cmd)) };
    case "eval":
      return { verb: "eval", target: trunc(str(n.code)) };
    case "crypto":
      return { verb: "crypto", target: `${str(n.method)} ${str(n.algo)}`.trim() };
    case "timer":
      return { verb: "timer", target: `${str(n.kind)} ${n.ms ?? ""}`.trim() };

    // L4 inspector — a dynamically-compiled script (file-backed scripts are
    // filtered out, so this is invariantly runtime-generated code). Show the
    // decoded SOURCE (the whitebox), flattened, with an explicit marker: that it
    // is dynamically compiled, its true length, and whether the captured source
    // was capped — a large decoded blob is itself notable, never silently cut.
    case "script_parsed": {
      const src = str(n.source).replace(/\s+/g, " ").trim();
      const len = int(n.len) ?? 0;
      const capped = len > str(n.source).length;
      const mark = len > 0 ? `  [dynamically compiled · ${len}c${capped ? " · capped" : ""}]` : "  [dynamically compiled]";
      return { verb: "script", target: trunc(src || str(n.url)) + mark };
    }
    case "debugger_paused":
      return { verb: "pause", target: "" };

    // engine synthetic
    case "truncated":
      return { verb: "truncated", target: "" };
    case "setup_bypass":
      return { verb: "bypass", target: "" };
    case "error":
      return { verb: "error", target: trunc(str(e.raw)) };
  }
}

// ── primitives ────────────────────────────────────────────────────────────────

const LAYER: Record<string, string> = {
  "L1:seccomp": "L1",
  "L2:pcap": "L2",
  "L3:fsDiff": "L3",
  "L4:monkey": "L4",
  "L4:v8inspector": "L4",
  engine: "ENG",
};
const layerTag = (e: Event): string => LAYER[e.stream] ?? e.stream;

const sec = (ns: number): string => (ns / 1e9).toFixed(2);

/** Parse the first syscall argument (the fd) from a verbatim L1 raw string like `write(5, …) = 64`. */
function l1Fd0(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\w+\((-?\d+)/);
  return m ? Number(m[1]) : null;
}

function tilde(path: string, home: string): string {
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

function trunc(s: string): string {
  return s.length > MAX_TARGET ? s.slice(0, MAX_TARGET) + "…" : s;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

function int(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function argv(v: unknown): string {
  return Array.isArray(v) && v.length ? JSON.stringify(v) : "";
}
