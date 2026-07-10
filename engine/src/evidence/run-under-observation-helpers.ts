import type {
  Event,
  EventSummary,
  RunArtifact,
  SetupApplied,
  Trigger,
} from "@npmguard/shared";
import { RunArtifact as RunArtifactSchema } from "@npmguard/shared";
import { canonicalize } from "./canonical-json.js";
import { sha256Hex } from "./hashing.js";

/**
 * Pure helpers for runUnderObservation. Kept separate so they can be unit-tested
 * without spinning up Docker.
 */

/**
 * Build the `docker exec` command array for a given trigger. `l4` prepends the
 * `--require /tmp/_instrument.js` preload (monkey-patch + in-process inspector).
 * Returns null for trigger kinds with no run command (`lifecycle`, `bin`).
 */
export function buildTriggerCommand(trigger: Trigger, l4: boolean): string[] | null {
  const nodeFlags: string[] = l4 ? ["--require", "/tmp/_instrument.js"] : [];

  switch (trigger.kind) {
    case "entrypoint": {
      const rel = trigger.target.startsWith(".") ? trigger.target : `./${trigger.target}`;
      return ["node", ...nodeFlags, "-e", `require(${JSON.stringify(rel)})`];
    }
    case "subpath":
      return ["node", ...nodeFlags, "-e", `require(${JSON.stringify(trigger.target)})`];
    case "lifecycle":
    case "bin":
      return null;
  }
}

/** Synthetic event emitted when a run is truncated due to budget overrun. */
export function truncationEvent(detail: string, timestampNs = 0): Event {
  return {
    stream: "engine",
    timestamp: timestampNs,
    pid: 0,
    kind: "truncated",
    raw: detail,
    normalized: { detail },
  };
}

/** Synthetic event emitted when a setup primitive is bypassed (logged, not applied). */
export function setupBypassEvent(detail: string): Event {
  return {
    stream: "engine",
    timestamp: 0,
    pid: 0,
    kind: "setup_bypass",
    raw: detail,
    normalized: { detail },
  };
}

/** Default setup state — nothing applied. Used when no manipulation primitives run. */
export function emptySetupApplied(): SetupApplied {
  return {
    env: {},
    date: null,
    plantFiles: [],
    stubUrls: [],
    hostname: null,
    locale: null,
    patches: [],
    preloadHash: null,
  };
}

/**
 * Compute the event summary from a list of events. Aggregates unique hosts,
 * syscalls seen, files written, and DNS queries.
 */
export function computeEventSummary(events: readonly Event[]): EventSummary {
  const uniqueHosts = new Set<string>();
  const uniqueSyscalls = new Set<string>();
  const filesWritten = new Set<string>();
  const dnsQueries = new Set<string>();

  const SYSCALL_KINDS: ReadonlySet<string> = new Set([
    "openat", "read", "write", "connect", "sendto", "execve", "clone", "unlink", "rename", "link",
  ]);

  for (const ev of events) {
    if (SYSCALL_KINDS.has(ev.kind)) {
      uniqueSyscalls.add(ev.kind);
    }

    if (ev.kind === "network") {
      const url = ev.normalized?.url;
      if (typeof url === "string" && url.length > 0) {
        try {
          uniqueHosts.add(new URL(url).hostname);
        } catch {
          // ignore malformed URL
        }
      }
    }

    if (ev.kind === "http_request" || ev.kind === "tls_sni") {
      const host = ev.normalized?.host;
      if (typeof host === "string") uniqueHosts.add(host);
    }

    if (ev.kind === "write" || ev.kind === "file_created" || ev.kind === "file_modified") {
      const p = ev.normalized?.path;
      if (typeof p === "string") filesWritten.add(p);
    }

    if (ev.kind === "dns_query") {
      const host = ev.normalized?.host;
      if (typeof host === "string") dnsQueries.add(host);
    }
  }

  return {
    uniqueHosts: [...uniqueHosts].sort(),
    uniqueSyscalls: [...uniqueSyscalls].sort(),
    filesWritten: [...filesWritten].sort(),
    dnsQueries: [...dnsQueries].sort(),
  };
}

/**
 * Finalize a draft RunArtifact: compute contentHash over the canonicalized
 * record (with contentHash set to the empty string), embed it, validate the
 * schema, return the sealed record.
 */
export function sealRunArtifact(draft: Omit<RunArtifact, "contentHash">): RunArtifact {
  const parsedNoHash = RunArtifactSchema.parse({ ...draft, contentHash: "" });
  const contentHash = sha256Hex(canonicalize({ ...parsedNoHash, contentHash: "" }));
  return { ...parsedNoHash, contentHash };
}
