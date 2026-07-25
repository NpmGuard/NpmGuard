/**
 * Unit: the panel tone/priority chokepoint — tone.tsx.
 *
 * Pure functions over the two axes (design §4.4): `outcome` (SAFE | ERROR |
 * DANGEROUS, null until concluded) and progress (`jobState`, scan `status`).
 *
 * Input classes:
 *  T1  outcomeTone — one class per outcome + null. ERROR gets its OWN tone: not
 *      `danger` (it does not block) and not `unknown` (it IS information).
 *  T2  toneAccent — every Tone resolves to a CSS var, unknown to the paper var.
 *  T3  scanTone — set progress outranks outcome: a running set is read before its
 *      rollup, and a null set is unknown. There is no failed-SET arm: the status
 *      domain is `running | done`, because R-1's falsification pass found zero
 *      producers for a failed set and a branch for an unreachable state is cost.
 *  T4  depPriority — the sort order: DANGEROUS > ERROR > running > queued > SAFE.
 *      ERROR above a live attempt is the load-bearing one — an errored dep needs
 *      a human, a running one resolves itself.
 *  T5  depTone — outcome, except a live attempt shows as running.
 *  T6  toneDotClass — unknown is the plain paper dot, every other tone a variant.
 *  T7  ANTI-DRIFT: every Tone the map can return has the base.css classes the
 *      components build from it (`pill--`, `dot--`, `rail__seg--`). A tone with
 *      no stylesheet renders as an unstyled element, which no type catches.
 *
 * Blackbox: call the exported functions; read base.css as text for T7.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditSet, AuditSetItem, Outcome } from "../../lib/engine-types.ts";
import {
  depPriority,
  depTone,
  outcomeTone,
  scanTone,
  toneAccent,
  toneDotClass,
  type Tone,
} from "./tone.tsx";

const dep = (over: Partial<AuditSetItem> = {}): AuditSetItem => ({
  name: "left-pad",
  version: "1.3.0",
  direct: true,
  range: "^1.0.0",
  outcome: null,
  verdictReason: null,
  evidenceCount: 0,
  auditedAt: null,
  jobState: null,
  cached: false,
  ...over,
});

/** An audit set with the outcome its rollup carries — the rollup IS the set's
 * verdict now, so a test cannot set one without the counters that justify it. */
const scan = (
  over: { status?: AuditSet["status"]; outcome?: Outcome | null } = {},
): AuditSet => ({
  id: 1,
  origin: "repo_scan",
  trigger: "manual",
  status: over.status ?? "done",
  rollup: {
    outcome: over.outcome ?? null,
    total: 3,
    safe: 1,
    dangerous: 0,
    error: 0,
    pending: over.status === "running" ? 2 : 0,
    cached: 1,
  },
  commitSha: null,
  startedAt: "2026-07-25T00:00:00.000Z",
  finishedAt: over.status === "running" ? null : "2026-07-25T00:01:00.000Z",
});

describe("outcomeTone", () => {
  it("T1: maps each outcome to its own tone, and null to unknown", () => {
    expect(outcomeTone("SAFE")).toBe("safe");
    expect(outcomeTone("DANGEROUS")).toBe("danger");
    expect(outcomeTone("ERROR")).toBe("error");
    expect(outcomeTone(null)).toBe("unknown");
  });

  it("T1: ERROR is neither danger nor unknown", () => {
    // It does not block (so not danger) and it is not the absence of
    // information (so not unknown) — folding it into either is what let a repo
    // with failed audits render as green.
    const tone = outcomeTone("ERROR");
    expect(tone).not.toBe("danger");
    expect(tone).not.toBe("unknown");
    expect(tone).not.toBe("safe");
  });
});

describe("toneAccent", () => {
  it("T2: every tone resolves to a CSS custom property", () => {
    const tones: Tone[] = ["safe", "danger", "error", "running", "unknown"];
    for (const tone of tones) expect(toneAccent(tone)).toMatch(/^var\(--[a-z-]+\)$/);
    expect(toneAccent("error")).toBe("var(--error)");
    expect(toneAccent("unknown")).toBe("var(--tone-paper-accent)");
  });
});

describe("scanTone", () => {
  it("T3: no scan is unknown", () => {
    expect(scanTone(null)).toBe("unknown");
  });

  it("T3: set progress is read before the outcome", () => {
    // A live set is `running` whatever its rollup says so far — progress and
    // outcome are the two §4.4 axes at set level, and the UI shows progress while
    // there is still progress to show.
    expect(scanTone(scan({ status: "running", outcome: null }))).toBe("running");
    expect(scanTone(scan({ status: "running", outcome: "SAFE" }))).toBe("running");
  });

  it("T3: a finished scan takes the tone of its outcome", () => {
    expect(scanTone(scan({ outcome: "SAFE" }))).toBe("safe");
    expect(scanTone(scan({ outcome: "ERROR" }))).toBe("error");
    expect(scanTone(scan({ outcome: "DANGEROUS" }))).toBe("danger");
    expect(scanTone(scan({ outcome: null }))).toBe("unknown");
  });
});

describe("depPriority", () => {
  it("T4: orders DANGEROUS > ERROR > running > queued > SAFE", () => {
    const ranks = [
      depPriority(dep({ outcome: "DANGEROUS" })),
      depPriority(dep({ outcome: "ERROR" })),
      depPriority(dep({ outcome: null, jobState: "running" })),
      depPriority(dep({ outcome: null, jobState: "queued" })),
      depPriority(dep({ outcome: "SAFE" })),
    ];
    expect(ranks).toStrictEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length); // no ties across classes
  });

  it("T4: an errored dep sorts above every pending one", () => {
    // The discriminating case: while ERROR was folded into the pending/unknown
    // bucket, a dep whose audit crashed sorted level with one still queued and
    // could be paged off the end of the list.
    const errored = depPriority(dep({ outcome: "ERROR" }));
    expect(errored).toBeLessThan(depPriority(dep({ outcome: null, jobState: "running" })));
    expect(errored).toBeLessThan(depPriority(dep({ outcome: null, jobState: "queued" })));
    expect(errored).toBeLessThan(depPriority(dep({ outcome: null, jobState: null })));
  });

  it("T4: SAFE sorts last", () => {
    const safe = depPriority(dep({ outcome: "SAFE" }));
    for (const other of [
      dep({ outcome: "DANGEROUS" }),
      dep({ outcome: "ERROR" }),
      dep({ outcome: null, jobState: "running" }),
      dep({ outcome: null, jobState: null }),
    ]) {
      expect(depPriority(other)).toBeLessThan(safe);
    }
  });
});

describe("depTone", () => {
  it("T5: a live attempt shows as running; everything else is its outcome", () => {
    expect(depTone(dep({ outcome: null, jobState: "running" }))).toBe("running");
    expect(depTone(dep({ outcome: null, jobState: "queued" }))).toBe("unknown");
    expect(depTone(dep({ outcome: "ERROR", jobState: "failed" }))).toBe("error");
    expect(depTone(dep({ outcome: "SAFE" }))).toBe("safe");
    expect(depTone(dep({ outcome: "DANGEROUS" }))).toBe("danger");
  });

  it("T5: a landed verdict wins over a stale job state", () => {
    // jobState describes the ATTEMPT; a stale failed job alongside a verdict
    // from a later attempt must not repaint a concluded dep.
    expect(depTone(dep({ outcome: "SAFE", jobState: "failed" }))).toBe("safe");
    expect(depTone(dep({ outcome: "DANGEROUS", jobState: "running" }))).toBe("danger");
  });
});

describe("toneDotClass", () => {
  it("T6: unknown is the plain dot, other tones get a variant", () => {
    expect(toneDotClass("unknown")).toBe("dot");
    expect(toneDotClass("error")).toBe("dot dot--error");
    expect(toneDotClass("danger")).toBe("dot dot--danger");
  });
});

describe("stylesheet coverage", () => {
  it("T7: every tone has its base.css pill / dot / rail classes", () => {
    // Resolved from the vitest cwd (the frontend package root) — under jsdom
    // `import.meta.url` is an http:// URL, not a file path.
    const css = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");
    // `unknown` is deliberately the unstyled fallback (plain `.dot`, paper accent).
    const styled: Tone[] = ["safe", "danger", "error", "running"];
    for (const tone of styled) {
      expect(css, `.dot--${tone}`).toContain(`.dot--${tone}`);
      expect(css, `.rail__seg--${tone}`).toContain(`.rail__seg--${tone}`);
    }
    for (const tone of ["safe", "danger", "error", "running"]) {
      expect(css, `.pill--${tone}`).toContain(`.pill--${tone}`);
    }
  });
});
