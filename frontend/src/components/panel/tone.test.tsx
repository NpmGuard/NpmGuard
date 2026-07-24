import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  verdictTone,
  toneAccent,
  scanTone,
  toneDotClass,
  VerdictPill,
  type Tone,
} from "./tone.tsx";

/**
 * Class map — tone.tsx is pure verdict→tone mapping (plus one tiny component).
 *
 * verdictTone(verdict): PanelVerdict|string|null|undefined → Tone
 *   C1  "SAFE"                 → "safe"
 *   C2  "DANGEROUS"            → "danger"
 *   C3  "SUSPECT"              → "suspect"   (reserved, dev engine never emits)
 *   C4  "UNKNOWN"              → "unknown"   (pending rollup bucket)
 *   C5  null                  → "unknown"   (pending, honest empty)
 *   C6  undefined             → "unknown"
 *   C7  unexpected string     → "unknown"   (safe fallback, never coerced up)
 *
 * toneAccent(tone): Tone → CSS var
 *   C8  safe/danger/suspect/running each map to their own var
 *   C9  unknown (default)     → var(--tone-paper-accent)
 *
 * scanTone(scan): ScanSummary|null → Tone  (running > failed > verdict)
 *   C10 null                  → "unknown"
 *   C11 status "running"      → "running"
 *   C12 status "failed"       → "danger"
 *   C13 completed + verdict   → delegates to verdictTone
 *
 * toneDotClass(tone): Tone → class string
 *   C14 unknown               → "dot"
 *   C15 any other tone        → "dot dot--<tone>"
 *
 * VerdictPill component
 *   C16 renders the raw verdict label + pill--<tone> class
 *
 * Honest invariant (pinned across the map): DANGEROUS never maps to the safe tone.
 */

describe("verdictTone", () => {
  it("C1: SAFE maps to the safe tone", () => {
    expect(verdictTone("SAFE")).toBe("safe");
  });

  it("C2: DANGEROUS maps to the danger tone", () => {
    expect(verdictTone("DANGEROUS")).toBe("danger");
  });

  it("C3: SUSPECT maps to the suspect tone", () => {
    expect(verdictTone("SUSPECT")).toBe("suspect");
  });

  it("C4: UNKNOWN maps to the unknown tone", () => {
    expect(verdictTone("UNKNOWN")).toBe("unknown");
  });

  it("C5: null (pending) maps to the unknown tone, never a fabricated verdict", () => {
    expect(verdictTone(null)).toBe("unknown");
  });

  it("C6: undefined maps to the unknown tone", () => {
    expect(verdictTone(undefined)).toBe("unknown");
  });

  it("C7: an unexpected string falls back safely to unknown", () => {
    expect(verdictTone("wat")).toBe("unknown");
    expect(verdictTone("safe")).toBe("unknown"); // case-sensitive; lowercase is not a member
  });

  it("HONEST: DANGEROUS is never coerced to the safe tone", () => {
    expect(verdictTone("DANGEROUS")).not.toBe("safe");
  });
});

describe("toneAccent", () => {
  it("C8: each concrete tone maps to its own CSS var", () => {
    expect(toneAccent("safe")).toBe("var(--safe)");
    expect(toneAccent("danger")).toBe("var(--danger)");
    expect(toneAccent("suspect")).toBe("var(--suspect)");
    expect(toneAccent("running")).toBe("var(--running)");
  });

  it("C9: the unknown tone falls back to the paper accent var", () => {
    expect(toneAccent("unknown")).toBe("var(--tone-paper-accent)");
  });

  it("HONEST: the danger accent is distinct from the safe accent", () => {
    expect(toneAccent("danger")).not.toBe(toneAccent("safe"));
  });
});

describe("scanTone", () => {
  it("C10: no scan is an honest unknown, not a verdict", () => {
    expect(scanTone(null)).toBe("unknown");
  });

  it("C11: a running scan reports the running tone regardless of verdict", () => {
    expect(scanTone({ status: "running", verdict: "SAFE" } as never)).toBe("running");
  });

  it("C12: a failed scan is danger, never a fabricated SAFE", () => {
    expect(scanTone({ status: "failed", verdict: "SAFE" } as never)).toBe("danger");
  });

  it("C13: a completed scan delegates to its verdict", () => {
    expect(scanTone({ status: "completed", verdict: "SAFE" } as never)).toBe("safe");
    expect(scanTone({ status: "completed", verdict: "DANGEROUS" } as never)).toBe("danger");
    expect(scanTone({ status: "completed", verdict: null } as never)).toBe("unknown");
  });

  it("C17: the real wire completion status 'done' delegates to its verdict, never a fabricated safe", () => {
    // The ScanSummary wire union is running|done|failed — "done", NOT the
    // "completed" C13 asserts, is the literal the engine actually emits. C13
    // only passes because scanTone's else-branch swallows any non-running/
    // non-failed status; the real completion path must be pinned on its own
    // literal so a status-switch refactor can't silently regress it.
    expect(scanTone({ status: "done", verdict: "SAFE" } as never)).toBe("safe");
    expect(scanTone({ status: "done", verdict: "DANGEROUS" } as never)).toBe("danger");
    expect(scanTone({ status: "done", verdict: null } as never)).toBe("unknown");
    // HONEST: a genuinely-finished DANGEROUS scan is never coerced to the safe tone.
    expect(scanTone({ status: "done", verdict: "DANGEROUS" } as never)).not.toBe("safe");
  });
});

describe("toneDotClass", () => {
  it("C14: the unknown tone renders a plain paper dot", () => {
    expect(toneDotClass("unknown")).toBe("dot");
  });

  it("C15: every other tone renders a tone-modified dot", () => {
    const tones: Tone[] = ["safe", "danger", "suspect", "running"];
    for (const t of tones) {
      expect(toneDotClass(t)).toBe(`dot dot--${t}`);
    }
  });
});

describe("VerdictPill", () => {
  it("C16: renders the raw verdict label with the tone-mapped pill class", () => {
    const { container } = render(<VerdictPill verdict="DANGEROUS" />);
    const pill = screen.getByText("DANGEROUS");
    expect(pill).toBeInTheDocument();
    expect(pill.className).toBe("pill pill--danger");
    expect(container.querySelector(".pill--safe")).toBeNull();
  });

  it("C16: a SAFE verdict renders the safe pill", () => {
    render(<VerdictPill verdict="SAFE" />);
    const pill = screen.getByText("SAFE");
    expect(pill.className).toBe("pill pill--safe");
  });

  it("C7/C16: an unexpected verdict string still renders its own label under the unknown pill", () => {
    render(<VerdictPill verdict="PENDING" />);
    const pill = screen.getByText("PENDING");
    expect(pill.className).toBe("pill pill--unknown");
  });
});
