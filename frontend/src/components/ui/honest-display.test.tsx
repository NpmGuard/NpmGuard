/**
 * Component: the components that must not overstate — meter.tsx, progress.tsx,
 * severity-ribbon.tsx, stat-tile.tsx, tabs.tsx.
 *
 * Each of these renders a *number*, and each has a way of being confidently wrong
 * that the design brief calls out by name. The tests are organised around those
 * failure modes rather than around the components, because the failure mode is
 * what a future edit will reintroduce.
 *
 * Input classes:
 *  C1  Meter: `value === null` (unknown) renders neither an empty nor a full bar,
 *      and never `0`. It also drops `role="meter"`, because the role's contract
 *      requires an `aria-valuenow` we do not honestly have.
 *  C2  Meter: `max === null` (unmetered) draws no bar at all — a full-looking bar
 *      for an unlimited plan is the same lie in the other direction.
 *  C3  Meter: the state machine is DERIVED from the numbers, so no call site can
 *      assert a state its numbers do not support.
 *  C4  Meter: over-limit wears `error` violet, not `danger` red — §0 rule 3
 *      reserves red for claims about packages.
 *  C5  Progress: `value === null` is indeterminate and exposes no `aria-valuenow`.
 *      There is no way to express a fabricated percentage (§2.9 rule 2).
 *  C6  Progress: the label is always rendered, so the information survives with
 *      animation disabled (§2.9 rule 1).
 *  C7  SeverityRibbon: pending is hatched, never coloured — an in-flight scan
 *      cannot read as green.
 *  C8  SeverityRibbon: segment order is fixed at DANGEROUS · ERROR · SAFE ·
 *      pending regardless of magnitude, and zero-count segments vanish.
 *  C9  StatTile: no value renders an em-dash, never `0`; a FAILED value renders
 *      the degraded field instead, and the two cannot both be passed.
 *  C10 Tabs: a count of 0 disables the tab rather than hiding it; a missing count
 *      renders no chip at all, because unknown and zero are different facts.
 *
 * Blackbox: rendered output + the pure `meterState` for the derivation.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Meter, meterState } from "./meter.tsx";
import { Progress } from "./progress.tsx";
import { SeverityRibbon } from "./severity-ribbon.tsx";
import { StatTile } from "./stat-tile.tsx";
import { Tabs, TabsList, TabsTrigger } from "./tabs.tsx";

describe("Meter", () => {
  it("C1: an unreadable value is hatched, is not a meter, and is not zero", () => {
    const { container } = render(<Meter label="Scans this month" value={null} max={50} />);
    expect(container.firstElementChild).toHaveAttribute("data-meter-state", "unknown");
    // No `role="meter"`: the role promises an aria-valuenow, and there isn't one.
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    // An em-dash, not `0`. A fabricated zero is a measurement never taken,
    // presented as one that was.
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b0\b/);
    // The hatch is what says "no signal" in greyscale, print and forced-colors.
    const bar = container.querySelector("[aria-hidden='true']");
    expect(bar?.getAttribute("style")).toMatch(/repeating-linear-gradient/);
  });

  it("C2: an unmetered plan draws no bar", () => {
    const { container } = render(<Meter label="Scans" value={412} max={null} />);
    expect(container.firstElementChild).toHaveAttribute("data-meter-state", "unmetered");
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.getByText(/No limit on this plan/)).toBeInTheDocument();
  });

  it("C3: the state is derived from the numbers", () => {
    expect(meterState(null, 50, 0.8)).toBe("unknown");
    expect(meterState(12, null, 0.8)).toBe("unmetered");
    expect(meterState(12, 50, 0.8)).toBe("normal");
    expect(meterState(41, 50, 0.8)).toBe("near-limit");
    expect(meterState(50, 50, 0.8)).toBe("over-limit");
    expect(meterState(63, 50, 0.8)).toBe("over-limit");
    // `unknown` wins over everything: no ceiling can make a missing value known.
    expect(meterState(null, null, 0.8)).toBe("unknown");
  });

  it("C4: over-limit uses the error slot, not danger", () => {
    const { container } = render(<Meter label="Scans" value={50} max={50} />);
    expect(container.firstElementChild).toHaveAttribute("data-meter-state", "over-limit");
    // Red would claim something about a package. An exhausted quota is "we could
    // not check", which shares the error slot with a failed read.
    expect(container.innerHTML).toMatch(/bg-error\b/);
    expect(container.innerHTML).not.toMatch(/bg-danger\b/);
  });

  it("C1: a normal meter exposes the meter role with an honest value", () => {
    render(<Meter label="Scans this month" value={12} max={50} valueText="12 of 50 scans used" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "12");
    expect(meter).toHaveAttribute("aria-valuemax", "50");
    // The assistive reading matches the visible one instead of a bare percentage.
    expect(meter).toHaveAttribute("aria-valuetext", "12 of 50 scans used");
  });
});

describe("Progress", () => {
  it("C5: an indeterminate bar exposes no value", () => {
    render(<Progress value={null} max={340} label="scanning dependencies" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuetext", "scanning dependencies");
  });

  it("C5: an indeterminate bar is hatched, not a creeping fill", () => {
    const { container } = render(<Progress value={null} max={340} label="scanning" />);
    const hatched = container.querySelector("[aria-hidden='true']");
    expect(hatched?.getAttribute("style")).toMatch(/repeating-linear-gradient/);
  });

  it("C6: the label is rendered as text, so the information survives without motion", () => {
    render(<Progress value={12} max={340} label="12 of 340 concluded" />);
    // §2.9 rule 1: if motion is the only thing saying the scan is alive, the scan
    // looks dead for every reduced-motion user.
    expect(screen.getByText("12 of 340 concluded")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "12");
  });
});

describe("SeverityRibbon", () => {
  it("C7: the pending segment is hatched and carries no outcome hue", () => {
    const { container } = render(
      <SeverityRibbon dangerous={3} error={12} safe={313} pending={12} />,
    );
    const pending = container.querySelector("[data-segment='pending']");
    expect(pending).not.toBeNull();
    // The single most important property of this component: an in-flight scan
    // cannot read as green.
    expect(pending?.getAttribute("style")).toMatch(/repeating-linear-gradient/);
    expect(pending?.className).not.toMatch(/safe|danger|error/);
  });

  it("C8: order is fixed regardless of magnitude", () => {
    const { container } = render(
      <SeverityRibbon dangerous={1} error={2} safe={999} pending={4} />,
    );
    const order = [...container.querySelectorAll("[data-segment]")].map((node) =>
      node.getAttribute("data-segment"),
    );
    // DANGEROUS is leftmost even when it is the smallest segment — the eye must
    // land on it first.
    expect(order).toStrictEqual(["dangerous", "error", "safe", "pending"]);
  });

  it("C8: zero-count segments are dropped, and counts are readable text", () => {
    const { container } = render(<SeverityRibbon dangerous={0} error={0} safe={7} pending={0} />);
    const order = [...container.querySelectorAll("[data-segment]")].map((node) =>
      node.getAttribute("data-segment"),
    );
    expect(order).toStrictEqual(["safe"]);
    // Counts are real text, not an aria-label blob, so each one is reachable.
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("no threat found")).toBeInTheDocument();
  });

  it("C7: a wholly empty ribbon is hatched rather than drawn as complete", () => {
    const { container } = render(<SeverityRibbon dangerous={0} error={0} safe={0} pending={0} />);
    expect(container.querySelector("[data-segment]")).toBeNull();
    expect(container.firstElementChild?.getAttribute("style")).toMatch(
      /repeating-linear-gradient/,
    );
  });
});

describe("StatTile", () => {
  it("C9: no value is an em-dash, never zero, and the definition is always present", () => {
    const { container } = render(
      <StatTile
        label="Caught"
        value={null}
        unit="%"
        definition="Confirmed malicious packages among those labelled malicious."
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b0\b/);
    // The unit is suppressed too: "— %" reads as a measured percentage.
    expect(container.textContent).not.toContain("%");
    expect(
      screen.getByText("Confirmed malicious packages among those labelled malicious."),
    ).toBeInTheDocument();
  });

  it("C9: a value of 0 that was actually read renders as 0", () => {
    render(<StatTile label="Confirmed" value={0} definition="Hypotheses confirmed." />);
    // The mirror of the previous case: a measured zero is information and must not
    // be laundered into an em-dash.
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("C9: a failed read renders the degraded field, not a dash", () => {
    render(
      <StatTile
        label="Caught"
        failure={{ what: "Benchmark results", detail: "GET /bench/results failed (500)" }}
        definition="Confirmed malicious packages among those labelled malicious."
      />,
    );
    expect(
      screen.getByRole("button", { name: /Benchmark results could not be loaded/ }),
    ).toBeInTheDocument();
  });

  it("C9: a tile cannot claim both a value and a failure", () => {
    // @ts-expect-error the two no-data channels are mutually exclusive arms.
    const both = <StatTile label="Caught" value={94} failure={{ what: "x" }} definition="d" />;
    expect(both).toBeDefined();
  });
});

describe("Tabs", () => {
  it("C10: a zero count disables the tab but keeps it visible", () => {
    render(
      <Tabs defaultValue="hypotheses">
        <TabsList>
          <TabsTrigger value="hypotheses" count={3}>
            Hypotheses
          </TabsTrigger>
          <TabsTrigger value="errors" count={0}>
            Errors
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const errors = screen.getByRole("tab", { name: /Errors/ });
    // Hiding it would destroy information — "Errors 0" is a fact the reader wants,
    // and a tab strip that changes shape makes the surface feel unstable.
    expect(errors).toBeInTheDocument();
    expect(errors).toBeDisabled();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("C10: an unknown count renders no chip and leaves the tab enabled", () => {
    render(
      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const files = screen.getByRole("tab", { name: "Files" });
    expect(files).toBeEnabled();
    // A missing count is not a zero count. Rendering "0" here would be a
    // fabricated measurement.
    expect(files.textContent).toBe("Files");
  });
});
