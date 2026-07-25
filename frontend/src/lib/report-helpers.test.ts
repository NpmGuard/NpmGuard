/**
 * Unit: report-helpers — pure helpers over the schemaVersion-2 AuditReport.
 *
 * Input classes:
 *  C1  confirmedHypotheses  — the CONFIRMED set = (state===CONFIRMED) ∪ (id in
 *                             confirmedHypIds), each row once, severity-sorted desc.
 *  C2  verdictHeadline      — HONEST headline: dealbreaker wins; else "N confirmed
 *                             threat(s)"; DANGEROUS-with-no-count never fabricates 0;
 *                             SAFE → "No known threats".
 *  C3  capabilitiesFromReport — distinct, falsy-skipping union over fileSummaries.
 *  C4  claimLabel           — known ClaimKind → label; unknown string → itself.
 *  C5  verdictTone          — DANGEROUS→danger, SAFE→safe.
 *  C6  hypothesis colour     — STATE decides, severity only modulates. A CRITICAL
 *                             hypothesis that was REFUTED carries NO danger hue
 *                             anywhere (that was the bug: 13 refuted hypotheses
 *                             rendered as 13 red rows); DEFERRED is neutral, never
 *                             amber, because "could not decide" is no finding
 *                             rather than a weak one; only CONFIRMED lets severity
 *                             reach the row, and only the state pill is coloured
 *                             on a refuted one — green, because that IS what we
 *                             now know.
 *  C7  byImportanceDesc      — state first, severity within: CONFIRMED → DEFERRED
 *                             → IN_PROGRESS → OPEN → REFUTED. A refuted CRITICAL
 *                             sorts BELOW a confirmed LOW, which is the whole
 *                             point — severity alone ranked disproved worries
 *                             above the real finding.
 *
 * Blackbox: reports/hypotheses are built via factories; assertions read outputs only.
 */

import { describe, expect, it } from "vitest";
import {
  byImportanceDesc,
  capabilitiesFromReport,
  claimLabel,
  confirmedHypotheses,
  hypothesisAccentVar,
  hypothesisSeverityTagClass,
  hypothesisStatePillClass,
  verdictHeadline,
  verdictTone,
} from "./report-helpers.ts";
import type { AuditReport, Hypothesis, HypothesisSeverity, HypothesisState } from "@npmguard/shared";

function hyp(id: string, severity: HypothesisSeverity, state: HypothesisState): Hypothesis {
  return {
    hypId: id,
    description: `${id} desc`,
    claim: { kind: "env_exfil", gating: null },
    focusFiles: [],
    focusLines: [],
    experiment: [],
    severity,
    parentHypId: null,
    childHypIds: [],
    state,
    createdBy: "flagger",
    evidenceRefs: [],
    createdAt: "2026-01-01T00:00:00Z",
    resolvedAt: null,
    resolution: null,
  };
}

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    schemaVersion: 2,
    verdict: "SAFE",
    rationale: "",
    counts: { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 },
    confirmedHypIds: [],
    hypotheses: [],
    fileSummaries: [],
    dealbreaker: null,
    trace: [],
    ...overrides,
  };
}

describe("report-helpers — C1 confirmedHypotheses", () => {
  it("C1: unions state===CONFIRMED with confirmedHypIds and sorts by severity desc", () => {
    const r = report({
      confirmedHypIds: ["h-listed"],
      hypotheses: [
        hyp("h-low", "low", "CONFIRMED"),
        hyp("h-listed", "critical", "REFUTED"), // in confirmedHypIds despite REFUTED state
        hyp("h-mid", "medium", "CONFIRMED"),
        hyp("h-open", "high", "OPEN"), // neither → excluded
      ],
    });
    const ids = confirmedHypotheses(r).map((h) => h.hypId);
    expect(ids).toEqual(["h-listed", "h-mid", "h-low"]); // critical > medium > low
    expect(ids).not.toContain("h-open");
  });

  it("C1: a hypothesis matched by both routes appears exactly once", () => {
    const r = report({
      confirmedHypIds: ["h1"],
      hypotheses: [hyp("h1", "high", "CONFIRMED")],
    });
    expect(confirmedHypotheses(r).map((h) => h.hypId)).toEqual(["h1"]);
  });
});

describe("report-helpers — C2 verdictHeadline (honest)", () => {
  it("C2: a dealbreaker wins the headline", () => {
    const r = report({ verdict: "DANGEROUS", dealbreaker: { check: "postinstall exfil", detail: "…" }, confirmedHypIds: ["h1"] });
    expect(verdictHeadline(r)).toBe("postinstall exfil");
  });

  it("C2: DANGEROUS with confirmed ids reports the count with correct pluralization", () => {
    expect(verdictHeadline(report({ verdict: "DANGEROUS", confirmedHypIds: ["h1"] }))).toBe("1 confirmed threat");
    expect(verdictHeadline(report({ verdict: "DANGEROUS", confirmedHypIds: ["h1", "h2", "h3"] }))).toBe("3 confirmed threats");
  });

  it("C2: DANGEROUS with no count never fabricates a 0 — falls back to a factual phrase", () => {
    const r = report({ verdict: "DANGEROUS", confirmedHypIds: [], hypotheses: [] });
    expect(verdictHeadline(r)).toBe("Confirmed malicious behavior");
    expect(verdictHeadline(r)).not.toContain("0");
  });

  it("C2: SAFE reads 'No known threats' (never an empty green count)", () => {
    expect(verdictHeadline(report({ verdict: "SAFE" }))).toBe("No known threats");
  });
});

describe("report-helpers — C3 capabilitiesFromReport", () => {
  it("C3: dedupes capabilities across files and skips falsy entries", () => {
    const r = report({
      fileSummaries: [
        { file: "a.js", summary: "", capabilities: ["NETWORK", "ENV_VARS"] },
        { file: "b.js", summary: "", capabilities: ["NETWORK", ""] },
        { file: "c.js", summary: "", capabilities: [] },
      ],
    });
    const caps = capabilitiesFromReport(r);
    expect(caps).toContain("NETWORK");
    expect(caps).toContain("ENV_VARS");
    expect(caps).not.toContain(""); // falsy dropped
    expect(caps.filter((c) => c === "NETWORK")).toHaveLength(1); // deduped
  });
});

describe("report-helpers — C4 claimLabel", () => {
  it("C4: a known claim maps to its human label", () => {
    expect(claimLabel("env_exfil")).toBe("Environment exfiltration");
  });
  it("C4: an unknown claim string falls back to itself", () => {
    expect(claimLabel("some_new_claim")).toBe("some_new_claim");
  });
});

describe("report-helpers — C5 verdictTone", () => {
  it("C5: DANGEROUS→danger, SAFE→safe", () => {
    expect(verdictTone("DANGEROUS")).toBe("danger");
    expect(verdictTone("SAFE")).toBe("safe");
  });
});

describe("C6: hypothesis colour is decided by state, modulated by severity", () => {
  const UNRESOLVED: HypothesisState[] = ["REFUTED", "DEFERRED", "OPEN", "IN_PROGRESS"];
  const SEVERITIES: HypothesisSeverity[] = ["critical", "high", "medium", "low"];

  it("C6: only a CONFIRMED hypothesis lets severity reach the row", () => {
    expect(hypothesisAccentVar("CONFIRMED", "critical")).toBe("var(--danger)");
    expect(hypothesisAccentVar("CONFIRMED", "high")).toBe("var(--danger)");
    expect(hypothesisAccentVar("CONFIRMED", "medium")).toBe("var(--suspect)");
    expect(hypothesisSeverityTagClass("CONFIRMED", "critical")).toBe("tag tag--danger");
  });

  it("C6: no unresolved state carries a hue, at ANY severity — the refuted-critical bug", () => {
    for (const state of UNRESOLVED) {
      for (const severity of SEVERITIES) {
        expect(hypothesisAccentVar(state, severity), `${state}/${severity}`).toBe(
          "var(--tone-paper-accent)",
        );
        expect(hypothesisSeverityTagClass(state, severity), `${state}/${severity}`).toBe("tag");
      }
    }
  });

  it("C6: the state pill is the one element that may be coloured on a refuted row", () => {
    expect(hypothesisStatePillClass("CONFIRMED")).toBe("pill pill--danger");
    expect(hypothesisStatePillClass("REFUTED")).toBe("pill pill--safe");
    // Ambiguous is grey. `pill--suspect` (amber) would claim a weak finding where
    // the investigation reached none.
    expect(hypothesisStatePillClass("DEFERRED")).toBe("pill");
    expect(hypothesisStatePillClass("OPEN")).toBe("pill pill--running");
    expect(hypothesisStatePillClass("IN_PROGRESS")).toBe("pill pill--running");
  });
});

describe("C7: hypotheses sort by importance, not by an untested claim's severity", () => {
  it("C7: state outranks severity — a refuted CRITICAL sits below a confirmed LOW", () => {
    const rows = [
      hyp("refuted-critical", "critical", "REFUTED"),
      hyp("confirmed-low", "low", "CONFIRMED"),
    ];
    expect(byImportanceDesc(rows).map((h) => h.hypId)).toEqual([
      "confirmed-low",
      "refuted-critical",
    ]);
  });

  it("C7: the full rank — could-not-decide above still-deciding, refuted last", () => {
    const rows = [
      hyp("refuted", "critical", "REFUTED"),
      hyp("open", "critical", "OPEN"),
      hyp("in-progress", "critical", "IN_PROGRESS"),
      hyp("deferred", "critical", "DEFERRED"),
      hyp("confirmed", "critical", "CONFIRMED"),
    ];
    expect(byImportanceDesc(rows).map((h) => h.hypId)).toEqual([
      "confirmed",
      "deferred",
      "in-progress",
      "open",
      "refuted",
    ]);
  });

  it("C7: severity still orders within one state, and the input is not mutated", () => {
    const rows = [
      hyp("c-medium", "medium", "CONFIRMED"),
      hyp("c-critical", "critical", "CONFIRMED"),
      hyp("c-high", "high", "CONFIRMED"),
    ];
    expect(byImportanceDesc(rows).map((h) => h.hypId)).toEqual([
      "c-critical",
      "c-high",
      "c-medium",
    ]);
    expect(rows.map((h) => h.hypId)).toEqual(["c-medium", "c-critical", "c-high"]);
  });
});
