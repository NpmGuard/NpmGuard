/**
 * Component: the alerts banner over each load state — AlertsNotice.tsx.
 *
 * The Dashboard test covers this path end to end; this file pins the component
 * itself, because the failure mode is a component-level one and it is silent.
 * The old version could not distinguish "the feed says there are no unseen
 * alerts" from "the feed could not be read": both produced `unseen.length === 0`
 * and both returned `null`. In a security product those two renders mean
 * opposite things.
 *
 * Input classes:
 *  A1  failed → named, never silent   — a failed read renders the degraded region,
 *                                       names the feed, and is marked
 *                                       `data-state="degraded"` for exactly this
 *                                       assertion.
 *  A2  ok + nothing unseen → silence  — the ONLY state allowed to render nothing,
 *                                       because here nothing is true.
 *  A3  ok + unseen → the banner        — with the count and the package identity.
 *  A4  seen alerts are not unseen      — an acked feed is silence, not a banner.
 *  A5  loading → silence               — a banner not yet drawn claims nothing, and it
 *                                       must not be confusable with the degraded state.
 *
 * Blackbox: render with a hand-built `LoadState`; assert on the accessibility tree
 * and the `data-state` attributes.
 */

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { failed, loaded, LOADING, type LoadState } from "../../../components/ui/load-state.ts";
import { alert, renderWithClient } from "../../../lib/test-harness.tsx";
import { AlertsNotice } from "./AlertsNotice.tsx";

type AlertList = LoadState<ReturnType<typeof alert>[]>;

describe("AlertsNotice — A1 a failed read is named, never silent", () => {
  it("A1: renders the degraded region with the feed's name", () => {
    const state: AlertList = failed({
      what: "Alerts feed",
      detail: "GET /panel/alerts failed (502)",
    });
    renderWithClient(<AlertsNotice state={state} />);

    expect(screen.getByText(/Alerts feed unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/502/)).toBeInTheDocument();
    expect(document.querySelector('[data-state="degraded"]')).not.toBeNull();
    // Not an empty state, and not the confident banner either.
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
  });
});

describe("AlertsNotice — A2/A4 silence only from a successful read", () => {
  it("A2: an empty feed that READ renders nothing", () => {
    renderWithClient(<AlertsNotice state={loaded([])} />);
    expect(document.body.textContent).toBe("");
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });

  it("A4: a feed whose alerts are all seen renders nothing", () => {
    renderWithClient(<AlertsNotice state={loaded([alert({ seen: true })])} />);
    expect(document.body.textContent).toBe("");
  });
});

describe("AlertsNotice — A3 unseen alerts render the banner", () => {
  it("A3: the count and the package identity are shown", () => {
    renderWithClient(
      <AlertsNotice
        state={loaded([alert({ id: 1 }), alert({ id: 2, packageName: "chalk", version: "5.0.0" })])}
      />,
    );
    expect(screen.getByText("2 new alerts")).toBeInTheDocument();
    expect(screen.getByText("left-pad@1.3.0")).toBeInTheDocument();
    expect(screen.getByText("chalk@5.0.0")).toBeInTheDocument();
    // Only DANGEROUS is ever raised, so the pill has one possible value.
    expect(screen.getAllByText("DANGEROUS")).toHaveLength(2);
  });
});

describe("AlertsNotice — A5 loading is its own state", () => {
  it("A5: renders nothing, and is not the degraded state", () => {
    renderWithClient(<AlertsNotice state={LOADING as AlertList} />);
    expect(document.body.textContent).toBe("");
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });
});
