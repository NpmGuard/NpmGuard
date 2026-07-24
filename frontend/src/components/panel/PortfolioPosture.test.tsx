/**
 * PortfolioPosture — aggregates a coverage rollup across repos' lastScan.
 *
 * CLASS MAP (input = the `repos` prop):
 *   C1: empty repos                      → honest null/empty branch, no fabricated posture
 *   C2: mixed portfolio                  → aggregate counts (attention/scanning/safe/unknown) correct in rail + legend
 *   C3: DANGEROUS lastScan               → counted as attention, NEVER folded into safe (honest invariant)
 *   C4: SUSPECT or FAILED lastScan       → also attention, not safe
 *   C5: unscanned (lastScan null) + UNKNOWN verdict → their own "unknown" bucket, never safe; audited vs not-audited split
 *   C6: protected ratio + percentage     → "{protected} of {total}" and rounded %
 *   C7: rail segments                    → only non-zero buckets get a segment; legend still lists every bucket (incl. 0)
 *
 * Blackbox: assert the rail's aria-label (the single string encoding all four
 * counts), the header/microtext, and the legend list items. The rail aria-label
 * and section aria-label are stable build-time hooks.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderRoute, resetPanelStore } from "../../test/render.tsx";
import { makeRepo, makeScan } from "../../test/panel-fixtures.ts";
import type { PanelRepo } from "../../lib/engine-types.ts";
import { PortfolioPosture } from "./PortfolioPosture.tsx";

let seq = 0;
/** A repo with a fresh id/name and the given lastScan, protected flag. */
function repo(over: Partial<PanelRepo> = {}): PanelRepo {
  seq += 1;
  return makeRepo({ id: 90000 + seq, name: `repo-${seq}`, ...over });
}

const safeRepo = (over: Partial<PanelRepo> = {}) =>
  repo({ lastScan: makeScan({ status: "done", verdict: "SAFE" }), ...over });
const dangerousRepo = (over: Partial<PanelRepo> = {}) =>
  repo({ lastScan: makeScan({ status: "done", verdict: "DANGEROUS" }), ...over });
const suspectRepo = (over: Partial<PanelRepo> = {}) =>
  repo({ lastScan: makeScan({ status: "done", verdict: "SUSPECT" }), ...over });
const failedRepo = (over: Partial<PanelRepo> = {}) =>
  repo({ lastScan: makeScan({ status: "failed", verdict: null }), ...over });
const runningRepo = (over: Partial<PanelRepo> = {}) =>
  repo({ lastScan: makeScan({ status: "running", verdict: null }), ...over });
const unknownRepo = (over: Partial<PanelRepo> = {}) =>
  repo({ lastScan: makeScan({ status: "done", verdict: "UNKNOWN" }), ...over });
const unscannedRepo = (over: Partial<PanelRepo> = {}) => repo({ lastScan: null, ...over });

/** The legend renders one <li> per bucket as "<label> <count>"; return them normalized. */
function legendTexts(): string[] {
  const section = screen.getByRole("region", { name: "Portfolio posture" });
  return within(section)
    .getAllByRole("listitem")
    .map((li) => li.textContent!.replace(/\s+/g, " ").trim());
}

beforeEach(() => {
  seq = 0;
  resetPanelStore();
});

describe("PortfolioPosture", () => {
  it("C1: empty repos render nothing — no fabricated posture from zero data", () => {
    renderRoute(<PortfolioPosture repos={[]} />);
    expect(screen.queryByRole("region", { name: "Portfolio posture" })).toBeNull();
    expect(screen.queryByText(/repositories protected/)).toBeNull();
  });

  it("C2: a mixed portfolio aggregates each bucket into the rail + legend", () => {
    const repos = [
      safeRepo({ protected: true }),
      safeRepo({ protected: true }),
      dangerousRepo(),
      runningRepo(),
      unscannedRepo(),
      unscannedRepo(),
    ];
    // attention=1, running=1, safe=2, unknown=2 (both unscanned)
    renderRoute(<PortfolioPosture repos={repos} />);

    expect(
      screen.getByRole("img", { name: "1 need attention, 1 scanning, 2 safe, 2 unknown" }),
    ).toBeTruthy();

    const legend = legendTexts();
    expect(legend).toContain("Attention 1");
    expect(legend).toContain("Scanning 1");
    expect(legend).toContain("Safe 2");
    expect(legend).toContain("Unknown 2");
  });

  it("C3: a DANGEROUS lastScan is counted as attention, never as safe", () => {
    const repos = [safeRepo(), dangerousRepo(), dangerousRepo()];
    // attention=2, safe=1 — the two DANGEROUS repos must NOT inflate safe.
    renderRoute(<PortfolioPosture repos={repos} />);

    expect(
      screen.getByRole("img", { name: "2 need attention, 0 scanning, 1 safe, 0 unknown" }),
    ).toBeTruthy();
    const legend = legendTexts();
    expect(legend).toContain("Attention 2");
    expect(legend).toContain("Safe 1");
  });

  it("C4: SUSPECT and FAILED lastScans also land in attention, not safe", () => {
    const repos = [suspectRepo(), failedRepo(), safeRepo()];
    // attention=2 (suspect + failed), safe=1
    renderRoute(<PortfolioPosture repos={repos} />);

    expect(
      screen.getByRole("img", { name: "2 need attention, 0 scanning, 1 safe, 0 unknown" }),
    ).toBeTruthy();
    expect(legendTexts()).toContain("Attention 2");
  });

  it("C5: unscanned (null) and UNKNOWN-verdict repos are their own bucket, never safe; audited split is honest", () => {
    const repos = [safeRepo(), unknownRepo(), unscannedRepo()];
    // safe=1, unknown=2 (one scanned-UNKNOWN, one unscanned). audited=2 (safe+unknown-verdict), not audited=1.
    renderRoute(<PortfolioPosture repos={repos} />);

    expect(
      screen.getByRole("img", { name: "0 need attention, 0 scanning, 1 safe, 2 unknown" }),
    ).toBeTruthy();
    expect(legendTexts()).toContain("Safe 1");
    expect(legendTexts()).toContain("Unknown 2");
    // audited counts a scanned-but-UNKNOWN repo; only the truly unscanned one is "not audited".
    expect(screen.getByText("2 audited · 1 not audited")).toBeTruthy();
  });

  it("C6: protection ratio and percentage reflect the protected flag, not the scan verdict", () => {
    const repos = [
      dangerousRepo({ protected: true }), // protected yet dangerous — ratio counts protection, not safety
      safeRepo(),
      unscannedRepo(),
    ];
    // protected=1 of 3 → round(33.33)=33
    renderRoute(<PortfolioPosture repos={repos} />);

    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByText(/repositories protected · 33%/)).toBeTruthy();
  });

  it("C8: a FAILED scan with a stale SAFE verdict is attention, never green — no fabricated safety from a crash", () => {
    // A crashed audit can leave a stale `verdict: "SAFE"` on the row. The failed
    // status MUST dominate: it lands in attention, never in safe. (Guards the
    // engine invariant that audit failure is never a SAFE verdict.)
    const repos = [
      repo({ lastScan: makeScan({ status: "failed", verdict: "SAFE" }) }),
      safeRepo(),
    ];
    renderRoute(<PortfolioPosture repos={repos} />);

    expect(
      screen.getByRole("img", { name: "1 need attention, 0 scanning, 1 safe, 0 unknown" }),
    ).toBeTruthy();
    const legend = legendTexts();
    expect(legend).toContain("Attention 1");
    expect(legend).toContain("Safe 1");
  });

  it("C7: the rail draws only non-zero buckets, while the legend still lists every bucket", () => {
    const repos = [safeRepo(), safeRepo(), safeRepo()];
    // safe=3, everything else 0
    const { container } = renderRoute(<PortfolioPosture repos={repos} />);

    // Only the safe segment is drawn (zero buckets are filtered out of the rail).
    const segs = container.querySelectorAll(".rail__seg");
    expect(segs.length).toBe(1);
    expect(segs[0].className).toContain("rail__seg--safe");

    // But the legend is exhaustive — the empty buckets are honestly shown as 0, not hidden.
    const legend = legendTexts();
    expect(legend).toContain("Attention 0");
    expect(legend).toContain("Scanning 0");
    expect(legend).toContain("Safe 3");
    expect(legend).toContain("Unknown 0");
  });
});
