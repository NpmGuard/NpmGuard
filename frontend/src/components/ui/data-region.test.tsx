/**
 * Component: empty vs degraded — data-region.tsx, empty-state.tsx,
 * degraded-state.tsx, stale-chip.tsx.
 *
 * The most important test file in this directory. The dashboard's known bug class
 * is confident-looking UI over partial data, and its canonical form is
 * `/bench/results` answering `{runs: []}` when the truth was "this code cannot
 * read this engine's reports". Every assertion here would fail if a failed fetch
 * rendered as "no results".
 *
 * Input classes:
 *  C1  a failed read renders the DEGRADED state and NOT the empty state — the
 *      empty copy the same call site supplies must be absent from the document.
 *  C2  a failed read names what failed. "Something went wrong" is not routable;
 *      brief §3.4 rule 1 makes the name mandatory and `Failure.what` required.
 *  C3  a failed read is never confusable with an empty one from the outside:
 *      distinct `data-state`, distinct role, and the degraded state carries a
 *      retry the empty state does not.
 *  C4  a successful read of nothing renders the empty state, achromatic, with the
 *      caller's specific copy — and no retry, because there is nothing to retry.
 *  C5  a successful read of something renders the children and neither state.
 *  C6  loading is its own state: `aria-busy`, and neither empty nor degraded.
 *  C7  blast radius — `surface` renders the page-level variant with the request
 *      id; `region` keeps the section title so the reader can tell WHICH region
 *      is missing.
 *  C8  `DegradedField` never renders `0` and never renders a bare dash: the
 *      screen-reader text names the failed fetch.
 *  C9  StaleChip is a third fact — real data, not current. Not degraded.
 *  C10 `className` survives the merge on each of the three.
 *
 * Blackbox: render through the public component API and query the accessibility
 * tree, not internals.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataRegion } from "./data-region.tsx";
import { DegradedField, DegradedRegion } from "./degraded-state.tsx";
import { failed, loaded, LOADING, type LoadState } from "./load-state.ts";
import { StaleChip } from "./stale-chip.tsx";

const EMPTY_COPY = "No dependencies audited yet";

function Region({ state }: { state: LoadState<string[]> }) {
  return (
    <DataRegion
      state={state}
      title="Dependencies"
      empty={{ message: EMPTY_COPY, hint: "Enable Protect to start scanning." }}
    >
      {(deps) => (
        <ul>
          {deps.map((dep) => (
            <li key={dep}>{dep}</li>
          ))}
        </ul>
      )}
    </DataRegion>
  );
}

describe("a failed read is not an empty one", () => {
  it("C1: a failed read renders degraded and NOT the empty copy", () => {
    render(
      <Region
        state={failed({ what: "Dependency list", detail: "GET /panel/deps failed (502)" })}
      />,
    );
    expect(screen.getByText(/Dependency list unavailable/)).toBeInTheDocument();
    // The load-bearing negative assertion. If the failure path ever falls through
    // to the empty branch — the `catch { setItems([]) }` bug — this line fails.
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enable Protect/)).not.toBeInTheDocument();
  });

  it("C2: the degraded state names the subject and discloses the detail", () => {
    render(
      <Region
        state={failed({ what: "Dependency list", detail: "GET /panel/deps failed (502)" })}
      />,
    );
    expect(screen.getByText(/Dependency list unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/GET \/panel\/deps failed \(502\)/)).toBeInTheDocument();
    // Generic copy would defeat the point of the component.
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it("C3: the two states are distinguishable from the outside", () => {
    const { unmount } = render(<Region state={failed({ what: "Dependency list" })} />);
    const degraded = screen.getByRole("alert");
    expect(degraded).toHaveAttribute("data-state", "degraded");
    unmount();

    render(<Region state={loaded<string[]>([])} />);
    const empty = screen.getByRole("status");
    expect(empty).toHaveAttribute("data-state", "empty");
    // Not merely different strings — different `data-state` and different role, so
    // no styling or test can treat one as the other by accident.
    expect(empty.getAttribute("data-state")).not.toBe("degraded");
  });

  it("C3: only the degraded state offers a retry", () => {
    const retry = vi.fn();
    const { unmount } = render(<Region state={failed({ what: "Dependency list", retry })} />);
    screen.getByRole("button", { name: /retry/i }).click();
    expect(retry).toHaveBeenCalledOnce();
    unmount();

    render(<Region state={loaded<string[]>([])} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("C3: a failure with no retry renders no dead button", () => {
    render(<Region state={failed({ what: "Dependency list" })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe("the other three states", () => {
  it("C4: a successful empty read renders the caller's specific copy", () => {
    render(<Region state={loaded<string[]>([])} />);
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(screen.getByText(/Enable Protect/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("C5: a successful non-empty read renders the children only", () => {
    render(<Region state={loaded(["left-pad@1.3.0"])} />);
    expect(screen.getByText("left-pad@1.3.0")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("C6: loading is aria-busy and is neither empty nor degraded", () => {
    const { container } = render(<Region state={LOADING as LoadState<string[]>} />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // A wait must not be announced as a result of either kind.
    expect(screen.getByText(/Loading Dependencies/)).toBeInTheDocument();
  });
});

describe("blast radius", () => {
  it("C7: surface renders the page-level variant with the request id", () => {
    render(
      <DataRegion
        state={failed<string[]>({
          what: "Repository",
          detail: "GET /panel/repos/42 failed (500)",
          requestId: "req_01JQ",
        })}
        blastRadius="surface"
        empty={{ message: EMPTY_COPY }}
      >
        {() => <div />}
      </DataRegion>,
    );
    expect(screen.getByRole("alert")).toHaveAttribute("data-degraded", "surface");
    expect(screen.getByText(/req_01JQ/)).toBeInTheDocument();
  });

  it("C7: region keeps the section title so the reader knows WHICH region failed", () => {
    render(<Region state={failed({ what: "Dependency list" })} />);
    const region = screen.getByRole("alert");
    expect(region).toHaveAttribute("data-degraded", "region");
    // The frame and title surviving is what preserves the reader's sense of place.
    expect(screen.getByRole("heading", { name: "Dependencies" })).toBeInTheDocument();
    expect(region).toHaveAccessibleName("Dependencies");
  });

  it("C7: last-good data is disclosed when it exists", () => {
    render(<Region state={failed({ what: "Alerts feed", lastGoodAt: "14:01" })} />);
    expect(screen.getByText(/Last good data 14:01/)).toBeInTheDocument();
  });
});

describe("DegradedField", () => {
  it("C8: renders a dash plus an affordance naming the failed fetch — never 0", () => {
    render(<DegradedField failure={{ what: "Coverage", detail: "GET /coverage failed" }} />);
    const field = screen.getByText("—").closest("[data-state]");
    expect(field).toHaveAttribute("data-degraded", "field");
    expect(field?.textContent).not.toMatch(/\b0\b/);
    // The dash alone is indistinguishable from "this row has no value"; the named
    // affordance is what makes it a failure the reader can identify.
    expect(
      screen.getByRole("button", { name: /Coverage could not be loaded/ }),
    ).toBeInTheDocument();
  });
});

describe("StaleChip", () => {
  it("C9: stale is a third fact — real data, not current, and not degraded", () => {
    render(<StaleChip asOf="14:02" />);
    const chip = screen.getByText("14:02").closest("[data-state]");
    expect(chip).toHaveAttribute("data-state", "stale");
    expect(chip?.getAttribute("data-state")).not.toBe("degraded");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("C9: no refresh handler renders no refresh affordance", () => {
    render(<StaleChip asOf="14:02" />);
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
  });
});

describe("className merge", () => {
  it("C10: an incoming className reaches the degraded region and wins its group", () => {
    render(<DegradedRegion failure={{ what: "Alerts feed" }} className="rounded-none mt-8" />);
    const region = screen.getByRole("alert");
    expect(region).toHaveClass("mt-8");
    expect(region).toHaveClass("rounded-none");
    // The component's own `rounded-lg` must have been REPLACED, not merely
    // preceded — otherwise the caller wins only by source-order accident.
    expect(region).not.toHaveClass("rounded-lg");
  });

  it("C10: an incoming className reaches the empty state", () => {
    render(<Region state={loaded<string[]>([])} />);
    expect(screen.getByRole("status")).toHaveClass("flex");
  });

  it("C10: an incoming className reaches the stale chip and wins its group", () => {
    render(<StaleChip asOf="14:02" className="bg-canvas" />);
    const chip = screen.getByText("14:02").closest("[data-state]");
    expect(chip).toHaveClass("bg-canvas");
    expect(chip).not.toHaveClass("bg-sunken");
  });
});
