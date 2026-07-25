/**
 * Unit: the audit-domain wire contract (@npmguard/shared) as a RUNTIME validator,
 * checked against REAL recorded engine output.
 *
 * `lib/contract.test.ts` asserts the panel half of the same property. This file
 * exists because the audit half was hand-restated in `engine-types.ts` for a
 * long time, and the argument for deleting a hand-written type is not "tsc is
 * happy" — it is "the schema that replaces it accepts what the engine actually
 * sends, and rejects what it cannot". Both halves of that are asserted here
 * against committed recordings rather than against hand-authored literals,
 * because a hand-authored literal only ever proves the schema agrees with the
 * author.
 *
 * Input classes:
 *  C1  real recorded frames    — every SSE frame in every committed demo recording
 *                                parses under AuditEventSchema. These are live
 *                                engine dumps (engine/demo-data/*.json, replayed
 *                                verbatim by demo.py), so this is the contract
 *                                meeting production traffic.
 *  C2  real recorded reports   — the schemaVersion-2 report inside each recording
 *                                parses under AuditReportSchema. Only COMMITTED
 *                                fixtures are read; see the note in C2.
 *  C3  listener/union coverage — EVENT_TYPES (what sse.ts subscribes to) is
 *                                EXACTLY the discriminant set of AuditEventSchema.
 *                                A union member missing from the list is an event
 *                                the client silently never receives; a list entry
 *                                missing from the union is a permanently dead
 *                                listener. Neither is catchable by the
 *                                `AuditEventType` alias, which shared derives from
 *                                EVENT_TYPES itself.
 *  C4  wire nullability        — the audit-domain fields the engine sends as an
 *                                explicit `null` parse as null (exclude_none=False),
 *                                and the fields it never sends as null REJECT null.
 *  C5  unrepresentable states  — the retired verdicts and the 7 retired event types
 *                                cannot be expressed, so an engine regression
 *                                cannot reintroduce them past this boundary.
 *
 * Blackbox: reads committed fixtures off disk and asserts only safeParse outcomes.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AuditEventSchema,
  AuditReportSchema,
  ClaimSchema,
  EVENT_TYPES,
  type AuditEventUnion,
} from "@npmguard/shared";

/** vitest runs with cwd = frontend/; the engine fixtures live one level up. */
const repoFile = (rel: string) => resolve(process.cwd(), "..", rel);
const readJson = (rel: string): unknown => JSON.parse(readFileSync(repoFile(rel), "utf8"));

/** Every committed demo recording — the engine's own captured audits, replayed
 * verbatim in demo/e2e mode. */
const RECORDINGS = ["engine/demo-data/chalk.json", "engine/demo-data/test-pkg-env-exfil.json"];

interface Recording {
  packageName: string;
  version: string;
  events: Record<string, unknown>[];
  report: unknown;
}

/**
 * Stamp the two envelope fields the recording omits. A recorded frame keeps
 * `type` + `timestamp` + its payload; `auditId` and `seq` belong to the live
 * session, so demo.py re-stamps them on replay (events.py `_wire_event`). Doing
 * the same here is what makes the recording a faithful stand-in for the wire.
 */
function asWireFrame(raw: Record<string, unknown>, seq: number): unknown {
  return { auditId: "demo-audit", seq, ...raw };
}

describe("audit wire contract — C1 real recorded frames", () => {
  for (const rel of RECORDINGS) {
    it(`C1: every recorded SSE frame in ${rel} parses under AuditEventSchema`, () => {
      const rec = readJson(rel) as Recording;
      expect(rec.events.length).toBeGreaterThan(0);
      const failures = rec.events
        .map((raw, i) => ({ raw, result: AuditEventSchema.safeParse(asWireFrame(raw, i + 1)) }))
        .filter(({ result }) => !result.success)
        .map(({ raw, result }) => `${String(raw["type"])}: ${JSON.stringify(result.error)}`);
      expect(failures).toEqual([]);
    });
  }

  it("C1: the recordings between them exercise most of the union, not one arm", () => {
    const seen = new Set<string>();
    for (const rel of RECORDINGS) {
      for (const e of (readJson(rel) as Recording).events) seen.add(String(e["type"]));
    }
    // Both recordings are successful audits, so the two terminal-failure and
    // queueing paths are not all present; the bulk of the pipeline is.
    expect(seen.size).toBeGreaterThanOrEqual(14);
    for (const type of seen) expect(EVENT_TYPES).toContain(type as never);
  });
});

describe("audit wire contract — C2 real recorded reports", () => {
  for (const rel of RECORDINGS) {
    it(`C2: the schemaVersion-2 report recorded in ${rel} parses under AuditReportSchema`, () => {
      const parsed = AuditReportSchema.safeParse((readJson(rel) as Recording).report);
      expect(parsed.success).toBe(true);
    });
  }

  // NOT asserted here: a durable report under `data/reports/<pkg>/<version>.json`.
  // `data/` is gitignored, so reading one makes the suite depend on whatever the
  // last local audit happened to leave behind — it passes on this machine and
  // fails on a fresh clone. Units are clone-and-run. The recordings above are
  // committed and come off the same `AuditReport` model that report_store.py
  // persists, so they cover the shape without the dependency.
});

describe("audit wire contract — C3 listener/union coverage", () => {
  it("C3: EVENT_TYPES is exactly the discriminant set of AuditEventSchema", () => {
    // zod exposes a discriminated union's members; each member's `type` shape is
    // the literal this arm is keyed on.
    const discriminants = AuditEventSchema.options
      .map((option) => option.shape.type.value as string)
      .sort();
    expect(discriminants).toEqual([...EVENT_TYPES].sort());
    expect(discriminants).toHaveLength(17);
  });
});

describe("audit wire contract — C4 wire nullability", () => {
  const base = { auditId: "a", timestamp: "2026-07-25T00:00:00Z", seq: 1 };

  it("C4: the fields the engine dumps as an explicit null parse as null", () => {
    // exclude_none=False, so an Optional engine field arrives as `null`, never
    // absent — a schema using .optional() would throw on this exact traffic.
    expect(
      AuditEventSchema.safeParse({
        ...base,
        type: "dependencies_provisioned",
        installed: false,
        packageCount: 0,
        skipped: null,
        error: null,
      }).success,
    ).toBe(true);
    expect(
      AuditEventSchema.safeParse({
        ...base,
        type: "file_verdict",
        verdict: {
          file: "index.js",
          capabilities: [],
          suspiciousPatterns: [],
          suspiciousLines: null, // every clean file sends this
          summary: "ok",
          riskContribution: 0,
        },
      }).success,
    ).toBe(true);
  });

  it("C4: audit_error rejects a null error/code/retryable — the engine cannot emit one", () => {
    // All three fields are supplied non-null by every emit site (service.py:184,
    // :246, :338) and the generated Pydantic model types them `str`/`str`/`bool`,
    // so an audit_error with nulls is not an emissible frame. The hand-written
    // type declared them `?: T | null`, which bought a fallback branch that could
    // never run and hid the fact that the message is always there.
    const ok = { ...base, type: "audit_error", error: "boom", code: "NPMGUARD-0031", retryable: true };
    expect(AuditEventSchema.safeParse(ok).success).toBe(true);
    for (const field of ["error", "code", "retryable"] as const) {
      expect(AuditEventSchema.safeParse({ ...ok, [field]: null }).success).toBe(false);
      const { [field]: _dropped, ...missing } = ok;
      expect(AuditEventSchema.safeParse(missing).success).toBe(false);
    }
  });

  it("C4: a Claim always carries `gating` — the engine never omits it", () => {
    // Same class: the hand-written Claim had `gating?:`, so a report could be
    // built in a shape the engine does not produce.
    expect(ClaimSchema.safeParse({ kind: "env_exfil", gating: null }).success).toBe(true);
    expect(ClaimSchema.safeParse({ kind: "env_exfil", gating: "time_gate" }).success).toBe(true);
    expect(ClaimSchema.safeParse({ kind: "not_a_claim", gating: null }).success).toBe(false);
    // `gating` may be OMITTED by a builder (it defaults to null) but never sent
    // as a bare absent field by the engine; what matters for a consumer is that
    // the parsed output always HAS the key, so a reader never branches on
    // "undefined vs null".
    expect(ClaimSchema.parse({ kind: "env_exfil" })).toEqual({ kind: "env_exfil", gating: null });
  });
});

describe("audit wire contract — C5 unrepresentable states", () => {
  it("C5: the retired SUSPECT / UNKNOWN verdicts cannot be expressed on a report", () => {
    const report = {
      schemaVersion: 2,
      verdict: "SAFE",
      rationale: "r",
      counts: { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 },
      confirmedHypIds: [],
      hypotheses: [],
      fileSummaries: [],
      dealbreaker: null,
      trace: [],
    };
    expect(AuditReportSchema.safeParse(report).success).toBe(true);
    for (const verdict of ["SUSPECT", "UNKNOWN", "ERROR", null]) {
      expect(AuditReportSchema.safeParse({ ...report, verdict }).success).toBe(false);
    }
  });

  it("C5: the 7 retired agent_*/verify_*/finding_discovered types are not union members", () => {
    const base = { auditId: "a", timestamp: "t", seq: 1 };
    for (const type of [
      "agent_thinking",
      "agent_tool_call",
      "agent_tool_result",
      "agent_reasoning",
      "finding_discovered",
      "verify_started",
      "verify_test_result",
    ]) {
      expect(AuditEventSchema.safeParse({ ...base, type }).success).toBe(false);
      expect(EVENT_TYPES).not.toContain(type as never);
    }
  });

  it("C5: a report missing a non-defaulted field fails rather than defaulting", () => {
    // `counts` and `verdict` carry no .default(), so a dropped engine field is a
    // loud failure — the property fetchAuditReport relies on.
    const report = {
      schemaVersion: 2,
      verdict: "SAFE",
      rationale: "r",
      counts: { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 },
      confirmedHypIds: [],
      hypotheses: [],
      fileSummaries: [],
      dealbreaker: null,
      trace: [],
    };
    const { counts: _c, ...noCounts } = report;
    expect(AuditReportSchema.safeParse(noCounts).success).toBe(false);
    const { verdict: _v, ...noVerdict } = report;
    expect(AuditReportSchema.safeParse(noVerdict).success).toBe(false);
  });
});

/** Compile-time half of C3: the union's discriminant must be assignable from the
 * list sse.ts iterates, in BOTH directions. shared derives `AuditEventType` from
 * EVENT_TYPES, so that alias cannot perform this check. */
const _listedAreUnionMembers: readonly AuditEventUnion["type"][] = EVENT_TYPES;
const _unionMembersAreListed: readonly (typeof EVENT_TYPES)[number][] =
  [] as AuditEventUnion["type"][];
void _listedAreUnionMembers;
void _unionMembersAreListed;
