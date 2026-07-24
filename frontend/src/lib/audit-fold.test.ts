/**
 * Unit: foldAuditEvent (the pure SSE reducer) — audit-fold.ts.
 *
 * Input classes (the shape of the (state, event) domain this reducer folds):
 *  C1  replay / idempotence      — a seq already folded is a no-op (same ref);
 *                                  re-folding a full buffer changes nothing.
 *  C2  unknown / dead types      — truly-unknown types hit `default`; the 7 dead
 *                                  agent_* / verify_* / finding_discovered types
 *                                  are tolerated (never throw).
 *  C3  lifecycle transitions     — each real emitted event moves the documented
 *                                  slice of state (audit_started … audit_error).
 *  C4  terminal freeze           — after a terminal event (verdict_reached /
 *                                  audit_error) later NON-terminal events are
 *                                  ignored; terminal events still pass the guard.
 *  C5  hypothesis upsert-in-place — emitted→resolved updates the same hypId entry
 *                                  in place (no duplicate row); verdict is terminal.
 *  C6  fixture cross-check        — the type sequence of a real skeleton fixture
 *                                  folds to a coherent DANGEROUS terminal state.
 *
 * Blackbox: events are built as typed AuditEvent objects; assertions read only
 * the returned AuditFoldState (never fold internals). seq/ts are ours to choose.
 */

import { describe, expect, it } from "vitest";
import { foldAuditEvent, initialFoldState, type AuditFoldState } from "./audit-fold.ts";
import type { AuditEvent } from "./engine-types.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Distributive Omit so the per-type payload keys survive the union.
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventPayload = DistOmit<AuditEvent, "auditId" | "timestamp" | "seq">;

/** Build a fully-typed AuditEvent, stamping the envelope base fields. */
function ev(seq: number, payload: EventPayload): AuditEvent {
  return {
    auditId: "audit-1",
    timestamp: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    seq,
    ...payload,
  } as AuditEvent;
}

/** Fold a whole buffer from the initial state. */
function foldAll(events: AuditEvent[], from: AuditFoldState = initialFoldState()): AuditFoldState {
  return events.reduce(foldAuditEvent, from);
}

describe("foldAuditEvent — C1 replay / idempotence", () => {
  it("C1: folding the same seq twice is a no-op returning the identical reference", () => {
    const s0 = initialFoldState();
    const s1 = foldAuditEvent(s0, ev(1, { type: "audit_started", packageName: "left-pad" }));
    const s2 = foldAuditEvent(s1, ev(1, { type: "audit_started", packageName: "OVERWRITE" }));
    expect(s2).toBe(s1); // same reference — the seq guard short-circuits
    expect(s2.packageName).toBe("left-pad"); // the duplicate never overwrote
  });

  it("C1: re-folding an entire buffer is a no-op (full-replay idempotence)", () => {
    const buffer: AuditEvent[] = [
      ev(1, { type: "audit_started", packageName: "left-pad" }),
      ev(2, { type: "phase_started", phase: "resolve" }),
      ev(3, { type: "phase_completed", phase: "resolve", durationMs: 42 }),
      ev(4, { type: "file_analyzing", file: "index.js" }),
    ];
    const once = foldAll(buffer);
    const twice = foldAll(buffer, once); // engine replays every row on reconnect
    expect(twice).toBe(once); // every seq is already seen → identical reference
    expect(twice.phases.find((p) => p.name === "resolve")?.status).toBe("done");
  });

  it("C1: an out-of-window duplicate mid-stream cannot re-open a closed slice", () => {
    const s = foldAll([
      ev(1, { type: "triage_progress", current: 2, total: 5, file: "a.js" }),
      ev(2, { type: "triage_complete", hypothesisCount: 0, hypotheses: [] }),
    ]);
    // triage_complete cleared triageProgress; replaying the earlier progress is a no-op.
    const replay = foldAuditEvent(s, ev(1, { type: "triage_progress", current: 2, total: 5, file: "a.js" }));
    expect(replay).toBe(s);
    expect(replay.triageProgress).toBeNull();
  });
});

describe("foldAuditEvent — C2 unknown / dead types tolerated", () => {
  it("C2: a truly-unknown type falls through to default and never throws", () => {
    const s0 = initialFoldState();
    const unknown = { auditId: "a", timestamp: "t", seq: 7, type: "brand_new_event", foo: 1 } as unknown as AuditEvent;
    let s1!: AuditFoldState;
    expect(() => {
      s1 = foldAuditEvent(s0, unknown);
    }).not.toThrow();
    // domain state is untouched; only the seq guard advanced.
    expect(s1.verdict).toBeNull();
    expect(s1.packageName).toBe("");
    expect(s1.pipelineLog).toHaveLength(0);
  });

  it("C2: the 7 dead agent_*/verify_*/finding_discovered types are tolerated (never throw)", () => {
    const dead: AuditEvent[] = [
      ev(1, { type: "agent_thinking", step: 0 }),
      ev(2, { type: "agent_tool_call", tool: "readFile", args: { path: "x.js" }, step: 1 }),
      ev(3, { type: "agent_tool_result", tool: "readFile", resultPreview: "…", step: 1, injectionDetected: false }),
      ev(4, { type: "agent_reasoning", text: "hmm", step: 2 }),
      ev(5, {
        type: "finding_discovered",
        finding: {
          capability: "NETWORK",
          confidence: "LIKELY",
          fileLine: "index.js:1",
          problem: "p",
          evidence: "e",
          reproductionStrategy: "r",
        },
      }),
      ev(6, { type: "verify_started", totalTests: 2 }),
      ev(7, { type: "verify_test_result", proofIndex: 0, testFile: "t.js", status: "confirmed", error: null }),
    ];
    expect(() => foldAll(dead)).not.toThrow();
    const s = foldAll(dead);
    expect(s.findings).toHaveLength(1); // handled, not crashed
    expect(s.running).toBe(true); // no terminal reached
  });
});

describe("foldAuditEvent — C3 lifecycle transitions", () => {
  it("C3: audit_started sets the package name", () => {
    const s = foldAuditEvent(initialFoldState(), ev(1, { type: "audit_started", packageName: "chalk" }));
    expect(s.packageName).toBe("chalk");
  });

  it("C3: audit_enqueued logs the queue position", () => {
    const s = foldAuditEvent(initialFoldState(), ev(1, { type: "audit_enqueued", queuePosition: 3 }));
    expect(s.pipelineLog.at(-1)?.text).toContain("position 3");
  });

  it("C3: phase_started marks the phase active and phase_completed records duration", () => {
    const s = foldAll([
      ev(1, { type: "phase_started", phase: "resolve" }),
      ev(2, { type: "phase_completed", phase: "resolve", durationMs: 1200 }),
    ]);
    expect(s.phase).toBe("resolve");
    const resolve = s.phases.find((p) => p.name === "resolve");
    expect(resolve?.status).toBe("done");
    expect(resolve?.durationMs).toBe(1200);
  });

  it("C3: a phase outside PHASE_ORDER is appended, never dropped", () => {
    const s = foldAuditEvent(initialFoldState(), ev(1, { type: "phase_started", phase: "mystery-phase" }));
    expect(s.phases.some((p) => p.name === "mystery-phase")).toBe(true);
  });

  it("C3: dependencies_provisioned records deps and an install line", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, { type: "dependencies_provisioned", installed: true, packageCount: 3, skipped: null, error: null }),
    );
    expect(s.deps).toEqual({ installed: true, packageCount: 3, skipped: null });
    expect(s.pipelineLog.at(-1)?.text).toBe("Installed 3 packages");
  });

  it("C3: dependencies_provisioned with skipped surfaces the skip reason", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, { type: "dependencies_provisioned", installed: false, packageCount: 0, skipped: "no manifest", error: null }),
    );
    expect(s.pipelineLog.at(-1)?.text).toContain("skipped: no manifest");
  });

  it("C3: file_list seeds every path as pending", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, {
        type: "file_list",
        files: [
          { path: "a/index.js", fileType: "javascript", sizeBytes: 10, permissions: "0644", isBinary: false, binaryType: null },
          { path: "b/util.js", fileType: "javascript", sizeBytes: 20, permissions: "0644", isBinary: false, binaryType: null },
        ],
      }),
    );
    expect(s.files).toHaveLength(2);
    expect(s.fileStatuses["a/index.js"]).toBe("pending");
    expect(s.fileStatuses["b/util.js"]).toBe("pending");
  });

  it("C3: inventory_meta strips the envelope and keeps only meta fields", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, {
        type: "inventory_meta",
        scripts: { postinstall: "node evil.js" },
        dependencies: { dependencies: { chalk: "^5" }, devDependencies: { vitest: "^4" } },
        entryPoints: { install: [], runtime: ["index.js"], bin: [] },
        metadata: { name: "p", version: "1.0.0", description: null, license: null },
      }),
    );
    expect(s.inventoryMeta).not.toBeNull();
    expect(s.inventoryMeta).not.toHaveProperty("type");
    expect(s.inventoryMeta).not.toHaveProperty("seq");
    expect(s.inventoryMeta?.entryPoints.runtime).toEqual(["index.js"]);
    // lifecycle script surfaced + a dependency-count line
    expect(s.pipelineLog.some((e) => e.text.includes("Lifecycle scripts"))).toBe(true);
    expect(s.pipelineLog.some((e) => e.text === "1 prod · 1 dev dependencies")).toBe(true);
  });

  it("C3: intent_extracted captures purpose and expected capabilities", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, { type: "intent_extracted", statedPurpose: "a chalk clone", expectedCapabilities: ["NONE"] }),
    );
    expect(s.statedPurpose).toBe("a chalk clone");
    expect(s.expectedCapabilities).toEqual(["NONE"]);
  });

  it("C3: file_analyzing marks the file analyzing and follows it only in the flag phase", () => {
    const inFlag = foldAll([
      ev(1, { type: "phase_started", phase: "flag" }),
      ev(2, { type: "file_analyzing", file: "index.js" }),
    ]);
    expect(inFlag.fileStatuses["index.js"]).toBe("analyzing");
    expect(inFlag.followFile).toBe("index.js");

    const inResolve = foldAll([
      ev(1, { type: "phase_started", phase: "resolve" }),
      ev(2, { type: "file_analyzing", file: "index.js" }),
    ]);
    expect(inResolve.followFile).toBeNull(); // not the flag phase → no auto-follow
  });

  it("C3: triage_progress records the current/total counter", () => {
    const s = foldAuditEvent(initialFoldState(), ev(1, { type: "triage_progress", current: 2, total: 8, file: "x.js" }));
    expect(s.triageProgress).toEqual({ current: 2, total: 8 });
  });

  it("C3: file_verdict maps risk to a file status and flags high risk", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, {
        type: "file_verdict",
        verdict: {
          file: "index.js",
          capabilities: ["NETWORK", "ENV_VARS"],
          suspiciousPatterns: ["exfil"],
          suspiciousLines: "10-14",
          summary: "exfiltrates env",
          riskContribution: 8,
        },
      }),
    );
    expect(s.fileStatuses["index.js"]).toBe("dangerous"); // risk 8 ≥ dangerous threshold
    expect(s.fileVerdicts["index.js"].capabilities).toContain("NETWORK");
    expect(s.pipelineLog.some((e) => e.kind === "file-flag")).toBe(true);
  });

  it("C3: a low-risk file_verdict is marked safe and raises no flag log", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, {
        type: "file_verdict",
        verdict: {
          file: "safe.js",
          capabilities: [],
          suspiciousPatterns: [],
          suspiciousLines: null,
          summary: "benign",
          riskContribution: 0,
        },
      }),
    );
    expect(s.fileStatuses["safe.js"]).toBe("safe");
    expect(s.pipelineLog.some((e) => e.kind === "file-flag")).toBe(false);
  });

  it("C3: triage_complete stores the summary, tracks hypotheses and clears progress", () => {
    const s = foldAll([
      ev(1, { type: "triage_progress", current: 1, total: 1, file: "index.js" }),
      ev(2, {
        type: "triage_complete",
        hypothesisCount: 2,
        hypotheses: [
          { hypId: "h1", claim: "env_exfil", severity: "high", description: "exfil env" },
          { hypId: "h2", claim: "dns_exfil", severity: "medium", description: "dns" },
        ],
      }),
    ]);
    expect(s.triage?.hypothesisCount).toBe(2);
    expect(s.hypotheses.map((h) => h.hypId)).toEqual(["h1", "h2"]);
    expect(s.triageProgress).toBeNull();
  });

  it("C3: graph_built logs a node count", () => {
    const s = foldAuditEvent(initialFoldState(), ev(1, { type: "graph_built", nodeCount: 5, addedCount: 5, mergedCount: 0 }));
    expect(s.pipelineLog.at(-1)?.text).toContain("5 nodes");
  });

  it("C3: audit_error freezes the run into an error state", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, { type: "audit_error", error: "sandbox timed out", code: "NPMGUARD-0031", retryable: true }),
    );
    expect(s.running).toBe(false);
    expect(s.error).toBe("sandbox timed out");
    expect(s.errorCode).toBe("NPMGUARD-0031");
    expect(s.errorRetryable).toBe(true);
  });

  it("C3: audit_error with null fields falls back to a generic message", () => {
    const s = foldAuditEvent(initialFoldState(), ev(1, { type: "audit_error", error: null, code: null, retryable: null }));
    expect(s.error).toBe("The audit failed");
    expect(s.errorRetryable).toBe(false);
  });
});

describe("foldAuditEvent — C4 terminal freeze", () => {
  it("C4: verdict_reached is terminal — running goes false and the verdict is set", () => {
    const s = foldAuditEvent(
      initialFoldState(),
      ev(1, {
        type: "verdict_reached",
        verdict: "DANGEROUS",
        rationale: "confirmed env exfil",
        counts: { total: 1, open: 0, inProgress: 0, confirmed: 1, refuted: 0, deferred: 0 },
        confirmedCount: 1,
      }),
    );
    expect(s.running).toBe(false);
    expect(s.verdict).toBe("DANGEROUS");
    expect(s.confirmedCount).toBe(1);
  });

  it("C4: a non-terminal event after the verdict is ignored (frozen)", () => {
    const terminal = foldAuditEvent(
      initialFoldState(),
      ev(1, {
        type: "verdict_reached",
        verdict: "SAFE",
        rationale: "all refuted",
        counts: { total: 2, open: 0, inProgress: 0, confirmed: 0, refuted: 2, deferred: 0 },
        confirmedCount: 0,
      }),
    );
    const after = foldAuditEvent(terminal, ev(2, { type: "phase_started", phase: "orchestrator" }));
    expect(after).toBe(terminal); // frozen — identical reference
    expect(after.phase).toBeNull();
  });

  it("C4: a terminal event still passes the guard after the run stopped", () => {
    const errored = foldAuditEvent(initialFoldState(), ev(1, { type: "audit_error", error: "boom", code: null, retryable: false }));
    // running is already false; a verdict event is terminal so the guard lets it through.
    const after = foldAuditEvent(errored, ev(2, {
      type: "verdict_reached",
      verdict: "SAFE",
      rationale: "x",
      counts: { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 },
      confirmedCount: 0,
    }));
    expect(after).not.toBe(errored);
    expect(after.verdict).toBe("SAFE");
  });
});

describe("foldAuditEvent — C5 hypothesis upsert-in-place", () => {
  it("C5: emitted→resolved updates the same hypId row in place (no duplicate)", () => {
    const s = foldAll([
      ev(1, { type: "hypothesis_emitted", hypId: "h1", claim: "env_exfil", severity: "high", file: "index.js" }),
      ev(2, {
        type: "hypothesis_resolved",
        hypId: "h1",
        claim: "env_exfil",
        severity: "high",
        state: "CONFIRMED",
        by: "judge",
        reason: "cited network exfil",
      }),
    ]);
    expect(s.hypotheses).toHaveLength(1); // upsert, not append
    expect(s.hypotheses[0].state).toBe("CONFIRMED");
    expect(s.hypotheses[0].reason).toBe("cited network exfil");
    expect(s.hypotheses[0].file).toBe("index.js"); // earlier field preserved through the merge
  });

  it("C5: two distinct hypIds keep separate rows", () => {
    const s = foldAll([
      ev(1, { type: "hypothesis_emitted", hypId: "h1", claim: "env_exfil", severity: "high", file: "a.js" }),
      ev(2, { type: "hypothesis_emitted", hypId: "h2", claim: "dns_exfil", severity: "low", file: "b.js" }),
    ]);
    expect(s.hypotheses.map((h) => h.hypId)).toEqual(["h1", "h2"]);
  });
});

describe("foldAuditEvent — C6 fixture cross-check (types only)", () => {
  it("C6: the env-exfil skeleton type-sequence folds to a DANGEROUS terminal state", () => {
    // The committed skeleton records the ACTUAL live type order (seq/ts are
    // nondeterministic, so we synthesize envelope + minimal payloads by type).
    // vitest runs with cwd = frontend/; the engine fixtures live one level up.
    const fixturePath = resolve(process.cwd(), "../engine/tests/fixtures/sse/test-pkg-env-exfil.skeleton.json");
    const skeleton = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      eventTypes: string[];
      terminal: { verdict: string; counts: Record<string, number> };
    };

    let hypSeq = 0;
    let resolveSeq = 0;
    const events: AuditEvent[] = skeleton.eventTypes.map((type, i) => {
      const seq = i + 1;
      switch (type) {
        case "audit_started":
          return ev(seq, { type, packageName: "test-pkg-env-exfil" });
        case "phase_started":
          return ev(seq, { type, phase: "flag" });
        case "phase_completed":
          return ev(seq, { type, phase: "flag", durationMs: 100 });
        case "dependencies_provisioned":
          return ev(seq, { type, installed: true, packageCount: 1, skipped: null, error: null });
        case "file_list":
          return ev(seq, { type, files: [] });
        case "inventory_meta":
          return ev(seq, {
            type,
            scripts: {},
            dependencies: {},
            entryPoints: { install: [], runtime: [], bin: [] },
            metadata: { name: null, version: null, description: null, license: null },
          });
        case "intent_extracted":
          return ev(seq, { type, statedPurpose: "x", expectedCapabilities: [] });
        case "file_analyzing":
          return ev(seq, { type, file: "index.js" });
        case "triage_progress":
          return ev(seq, { type, current: 1, total: 2, file: "index.js" });
        case "hypothesis_emitted": {
          hypSeq += 1;
          return ev(seq, { type, hypId: `h${hypSeq}`, claim: "env_exfil", severity: "high", file: "index.js" });
        }
        case "file_verdict":
          return ev(seq, {
            type,
            verdict: { file: "index.js", capabilities: [], suspiciousPatterns: [], suspiciousLines: null, summary: "s", riskContribution: 6 },
          });
        case "triage_complete":
          return ev(seq, { type, hypothesisCount: 0, hypotheses: [] });
        case "graph_built":
          return ev(seq, { type, nodeCount: 1, addedCount: 1, mergedCount: 0 });
        case "hypothesis_resolved": {
          resolveSeq += 1;
          return ev(seq, {
            type,
            hypId: `h${resolveSeq}`,
            claim: "env_exfil",
            severity: "high",
            state: resolveSeq === 1 ? "CONFIRMED" : "REFUTED",
            by: "judge",
            reason: "r",
          });
        }
        case "verdict_reached":
          return ev(seq, {
            type,
            verdict: skeleton.terminal.verdict as "SAFE" | "DANGEROUS",
            rationale: "r",
            counts: skeleton.terminal.counts as never,
            confirmedCount: skeleton.terminal.counts.confirmed,
          });
        default:
          return ev(seq, { type: type as never });
      }
    });

    const s = foldAll(events);
    expect(s.running).toBe(false);
    expect(s.verdict).toBe("DANGEROUS");
    expect(s.confirmedCount).toBe(1);
    // Upsert-by-hypId keeps rows unique: h1..hN where N = max(emitted, resolved).
    const emitted = skeleton.eventTypes.filter((t) => t === "hypothesis_emitted").length;
    const resolved = skeleton.eventTypes.filter((t) => t === "hypothesis_resolved").length;
    expect(s.hypotheses.length).toBe(Math.max(emitted, resolved));
  });
});
