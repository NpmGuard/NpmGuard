import { describe, it, expect } from "vitest";
import {
  buildTriggerCommand,
  computeEventSummary,
  emptySetupApplied,
  sealRunArtifact,
  setupBypassEvent,
  truncationEvent,
} from "./run-under-observation-helpers.js";
import type { Event, RunArtifact } from "@npmguard/shared";

describe("buildTriggerCommand", () => {
  it("entrypoint without instrumentation", () => {
    expect(
      buildTriggerCommand({ kind: "entrypoint", target: "index.js", argv: [], stdin: null }, false),
    ).toEqual(["node", "-e", `require("./index.js")`]);
  });

  it("entrypoint with L4 instrumentation", () => {
    expect(
      buildTriggerCommand({ kind: "entrypoint", target: "setup.js", argv: [], stdin: null }, true),
    ).toEqual(["node", "--require", "/tmp/_instrument.js", "-e", `require("./setup.js")`]);
  });

  it("entrypoint preserves existing './' prefix", () => {
    expect(
      buildTriggerCommand({ kind: "entrypoint", target: "./lib/init.js", argv: [], stdin: null }, false),
    ).toEqual(["node", "-e", `require("./lib/init.js")`]);
  });

  it("subpath passes target through verbatim", () => {
    expect(
      buildTriggerCommand({ kind: "subpath", target: "pkg/lib/inner.js", argv: [], stdin: null }, true),
    ).toEqual(["node", "--require", "/tmp/_instrument.js", "-e", `require("pkg/lib/inner.js")`]);
  });

  it("returns null for lifecycle (not supported in Sprint 2)", () => {
    expect(
      buildTriggerCommand({ kind: "lifecycle", target: "preinstall", argv: [], stdin: null }, true),
    ).toBeNull();
  });

  it("returns null for bin (not supported in Sprint 2)", () => {
    expect(
      buildTriggerCommand({ kind: "bin", target: "mybin", argv: [], stdin: null }, true),
    ).toBeNull();
  });
});

describe("truncationEvent + setupBypassEvent", () => {
  it("truncationEvent carries detail in both raw and normalized", () => {
    const ev = truncationEvent("budget exceeded", 42);
    expect(ev.stream).toBe("engine");
    expect(ev.kind).toBe("truncated");
    expect(ev.timestamp).toBe(42);
    expect(ev.raw).toBe("budget exceeded");
    expect(ev.normalized).toEqual({ detail: "budget exceeded" });
  });

  it("setupBypassEvent marks a setup primitive as logged-not-applied", () => {
    const ev = setupBypassEvent("stubUrl bypassed via raw socket");
    expect(ev.stream).toBe("engine");
    expect(ev.kind).toBe("setup_bypass");
  });
});

describe("emptySetupApplied", () => {
  it("returns all defaults", () => {
    expect(emptySetupApplied()).toEqual({
      env: {},
      date: null,
      plantFiles: [],
      stubUrls: [],
      hostname: null,
      locale: null,
      patches: [],
      preloadHash: null,
    });
  });
});

describe("computeEventSummary", () => {
  it("empty events produce empty summary", () => {
    expect(computeEventSummary([])).toEqual({
      uniqueHosts: [],
      uniqueSyscalls: [],
      filesWritten: [],
      dnsQueries: [],
    });
  });

  it("aggregates unique L1 syscalls", () => {
    const events: Event[] = [
      { stream: "L1:seccomp", timestamp: 0, pid: 1, kind: "openat", raw: {} },
      { stream: "L1:seccomp", timestamp: 1, pid: 1, kind: "read", raw: {} },
      { stream: "L1:seccomp", timestamp: 2, pid: 1, kind: "openat", raw: {} },
      { stream: "L1:seccomp", timestamp: 3, pid: 1, kind: "connect", raw: {} },
    ];
    expect(computeEventSummary(events).uniqueSyscalls).toEqual(["connect", "openat", "read"]);
  });

  it("extracts hosts from L4 network events", () => {
    const events: Event[] = [
      { stream: "L4:monkey", timestamp: 0, pid: 0, kind: "network", raw: {}, normalized: { method: "GET", url: "http://attacker.com/c2" } },
      { stream: "L4:monkey", timestamp: 1, pid: 0, kind: "network", raw: {}, normalized: { method: "POST", url: "https://attacker.com/exfil" } },
      { stream: "L4:monkey", timestamp: 2, pid: 0, kind: "network", raw: {}, normalized: { method: "GET", url: "http://api.legit.com/ok" } },
    ];
    expect(computeEventSummary(events).uniqueHosts).toEqual(["api.legit.com", "attacker.com"]);
  });

  it("extracts DNS queries", () => {
    const events: Event[] = [
      { stream: "L2:pcap", timestamp: 0, pid: 1, kind: "dns_query", raw: {}, normalized: { host: "attacker.com" } },
      { stream: "L2:pcap", timestamp: 1, pid: 1, kind: "dns_query", raw: {}, normalized: { host: "attacker.com" } },
    ];
    expect(computeEventSummary(events).dnsQueries).toEqual(["attacker.com"]);
  });

  it("extracts files written from L3 + L1 write events", () => {
    const events: Event[] = [
      { stream: "L1:seccomp", timestamp: 0, pid: 1, kind: "write", raw: {}, normalized: { path: "/tmp/payload" } },
      { stream: "L3:fsDiff", timestamp: 1, pid: 0, kind: "file_created", raw: {}, normalized: { path: "/etc/persist.sh" } },
    ];
    expect(computeEventSummary(events).filesWritten).toEqual(["/etc/persist.sh", "/tmp/payload"]);
  });

  it("ignores malformed URLs silently", () => {
    const events: Event[] = [
      { stream: "L4:monkey", timestamp: 0, pid: 0, kind: "network", raw: {}, normalized: { method: "GET", url: "not a url" } },
    ];
    expect(computeEventSummary(events).uniqueHosts).toEqual([]);
  });
});

describe("sealRunArtifact", () => {
  function baseline(): Omit<RunArtifact, "contentHash"> {
    return {
      runId: "run_seal_test",
      triggerUsed: { kind: "entrypoint", target: "index.js", argv: [], stdin: null },
      setupApplied: emptySetupApplied(),
      observe: { kernel: false, network: false, fsDiff: false, node: true, inspector: false },
      budget: { wallMs: 30_000, maxSyscalls: null, maxBytesCapture: null },
      wallMs: 100,
      exitCode: 0,
      timedOut: false,
      events: [],
      stdoutHash: null,
      stderrHash: null,
      fsDiffHash: null,
      pcapHash: null,
      inspectorLogHash: null,
      eventSummary: { uniqueHosts: [], uniqueSyscalls: [], filesWritten: [], dnsQueries: [] },
      error: null,
      createdAt: "2026-04-18T10:00:00.000Z",
    };
  }

  it("computes a 64-char hex content hash", () => {
    const sealed = sealRunArtifact(baseline());
    expect(sealed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("identical drafts produce identical content hashes", () => {
    expect(sealRunArtifact(baseline()).contentHash).toBe(
      sealRunArtifact(baseline()).contentHash,
    );
  });

  it("different drafts produce different hashes", () => {
    const a = sealRunArtifact(baseline());
    const modified = { ...baseline(), wallMs: 999 };
    const b = sealRunArtifact(modified);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("the sealed hash verifies (reconstructing the draft from the sealed record yields the same hash)", () => {
    const sealed = sealRunArtifact(baseline());
    const { contentHash, ...draft } = sealed;
    expect(sealRunArtifact(draft).contentHash).toBe(contentHash);
  });
});
