import type { Event, EventKind } from "@npmguard/shared";

/**
 * L1 syscall sensor via `strace -f -ttt -s 4096 -o /tmp/strace.log`.
 *
 * v1 uses strace rather than seccomp-bpf audit because strace is a single
 * binary with zero setup, whereas seccomp-audit requires a custom seccomp
 * profile and kernel-audit log ingestion. Known v1 gap: strace sets
 * `/proc/self/status:TracerPid` to non-zero, which sophisticated malware
 * can detect. Swapping to seccomp-bpf audit is a localized later change
 * — this module owns the log-parsing path, which doesn't care about
 * the backend.
 */

const TRACED_SYSCALLS = [
  // Filesystem
  "openat", "open", "read", "write",
  "unlink", "unlinkat",
  "rename", "renameat", "renameat2",
  "link", "linkat",
  // Network
  "connect", "sendto", "recvfrom", "accept", "accept4",
  // Process
  "execve", "clone", "clone3", "fork", "vfork",
];

export function straceTraceFlag(): string {
  return TRACED_SYSCALLS.join(",");
}

/**
 * Wrap an in-container command under strace. Prepends the strace invocation
 * so the traced command's args (including node's -e literal) pass through
 * unchanged.
 */
export function wrapWithStrace(cmd: readonly string[]): string[] {
  return [
    "strace",
    "-f",               // follow forks / threads
    "-ttt",             // absolute Unix timestamps with microseconds
    "-s", "4096",       // string-arg max length
    "-o", "/tmp/strace.log",
    "-e", `trace=${straceTraceFlag()}`,
    ...cmd,
  ];
}

interface ParsedStraceLine {
  timestamp: number;   // Unix seconds (with fractional µs)
  pid: number | null;  // null for the main process (single-process strace)
  syscall: string;
  args: string;
  ret: string;
}

// Strace -f emits three possible prefix formats depending on version:
//   1. Bare PID:       "42    1700000000.000 syscall(args) = ret"    (modern)
//   2. Bracketed PID:  "[pid 42] 1700000000.000 syscall(args) = ret" (older)
//   3. No PID prefix:  "1700000000.000 syscall(args) = ret"          (no -f)
const TAIL_RE = /(\w+)\((.*)\)\s+=\s+(-?\d+|0x[0-9a-f]+|\?)(?:\s|$)/;
const FMT_BARE_PID = new RegExp(String.raw`^(\d+)\s+(\d+\.\d+)\s+` + TAIL_RE.source);
const FMT_BRACKET = new RegExp(String.raw`^\[pid\s+(\d+)\]\s+(\d+\.\d+)\s+` + TAIL_RE.source);
const FMT_NO_PID = new RegExp(String.raw`^(\d+\.\d+)\s+` + TAIL_RE.source);

/** Parse a single strace line. Returns null for unfinished/resumed/info lines. */
export function parseStraceLine(line: string): ParsedStraceLine | null {
  if (!line) return null;
  if (line.includes("<unfinished ...>") || line.includes("<... ")) return null;

  let m = line.match(FMT_BARE_PID);
  if (m) {
    return {
      pid: Number(m[1]),
      timestamp: Number(m[2]),
      syscall: m[3]!,
      args: m[4]!,
      ret: m[5]!,
    };
  }
  m = line.match(FMT_BRACKET);
  if (m) {
    return {
      pid: Number(m[1]),
      timestamp: Number(m[2]),
      syscall: m[3]!,
      args: m[4]!,
      ret: m[5]!,
    };
  }
  m = line.match(FMT_NO_PID);
  if (m) {
    return {
      pid: null,
      timestamp: Number(m[1]),
      syscall: m[2]!,
      args: m[3]!,
      ret: m[4]!,
    };
  }
  return null;
}

/**
 * Parse an entire strace log into ordered L1 Events. Timestamps are
 * relative to `runStartSec` in nanoseconds (clamped to 0 for pre-run
 * lines such as strace's own startup noise).
 */
export function parseStraceLog(log: string, runStartSec: number): Event[] {
  const events: Event[] = [];
  for (const line of log.split("\n")) {
    const parsed = parseStraceLine(line);
    if (!parsed) continue;
    events.push(toEvent(parsed, runStartSec));
  }
  return events;
}

function toEvent(p: ParsedStraceLine, runStartSec: number): Event {
  const deltaSec = p.timestamp - runStartSec;
  const timestampNs = Number.isFinite(deltaSec)
    ? Math.max(0, Math.round(deltaSec * 1e9))
    : 0;

  return {
    stream: "L1:seccomp",
    timestamp: timestampNs,
    pid: p.pid ?? 0,
    kind: mapSyscallKind(p.syscall),
    raw: `${p.syscall}(${p.args}) = ${p.ret}`,
    normalized: extractNormalized(p.syscall, p.args, p.ret),
  };
}

function mapSyscallKind(name: string): EventKind {
  switch (name) {
    case "openat":
    case "open":
      return "openat";
    case "read":
      return "read";
    case "write":
      return "write";
    case "connect":
      return "connect";
    case "sendto":
      return "sendto";
    case "execve":
      return "execve";
    case "clone":
    case "clone3":
    case "fork":
    case "vfork":
      return "clone";
    case "unlink":
    case "unlinkat":
      return "unlink";
    case "rename":
    case "renameat":
    case "renameat2":
      return "rename";
    case "link":
    case "linkat":
      return "link";
    default:
      return "openat"; // fallback — shouldn't hit with our trace filter
  }
}

function extractNormalized(
  syscall: string,
  args: string,
  ret: string,
): Record<string, unknown> {
  const base = { ret };
  switch (syscall) {
    case "openat":
    case "open": {
      const path = firstQuoted(args);
      return { ...base, path };
    }
    case "execve": {
      const path = firstQuoted(args);
      const argv = extractArgv(args);
      return { ...base, path, argv };
    }
    case "read":
    case "write": {
      const fd = Number.parseInt(args.match(/^(\d+)/)?.[1] ?? "", 10);
      return { ...base, fd: Number.isFinite(fd) ? fd : null };
    }
    case "connect":
    case "sendto": {
      const ip4 = args.match(/sin_addr="([^"]+)"/)?.[1];
      const ip6 = args.match(/sin6_addr="([^"]+)"/)?.[1];
      const port = args.match(/htons\((\d+)\)/)?.[1];
      return {
        ...base,
        addr: ip4 ?? ip6 ?? null,
        port: port ? Number(port) : null,
      };
    }
    case "unlink":
    case "unlinkat": {
      return { ...base, path: lastQuoted(args) };
    }
    case "rename":
    case "renameat":
    case "renameat2":
    case "link":
    case "linkat": {
      const quotes = allQuoted(args);
      return { ...base, from: quotes[0] ?? "", to: quotes[quotes.length - 1] ?? "" };
    }
    default:
      return base;
  }
}

/** Extract the first double-quoted string from a strace arg list. */
function firstQuoted(args: string): string {
  return args.match(/"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
}

/** Extract the last double-quoted string from a strace arg list. */
function lastQuoted(args: string): string {
  const all = allQuoted(args);
  return all[all.length - 1] ?? "";
}

/** Extract all double-quoted strings in order. */
function allQuoted(args: string): string[] {
  return [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

/**
 * For execve, extract the argv array. strace renders it as a second arg like
 * `["node", "--require", "/tmp/_instrument.js"]`.
 */
function extractArgv(args: string): string[] {
  const bracketStart = args.indexOf("[");
  const bracketEnd = args.indexOf("]", bracketStart);
  if (bracketStart === -1 || bracketEnd === -1) return [];
  const inside = args.slice(bracketStart + 1, bracketEnd);
  return allQuoted(inside);
}
