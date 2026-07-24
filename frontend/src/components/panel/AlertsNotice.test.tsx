/**
 * AlertsNotice — unseen-alerts banner (count, first three alerts, mark-as-seen).
 *
 * Class map (input equivalence classes over the store `alerts` slot):
 *   C1  no alerts at all                     → renders nothing
 *   C2  alerts present but ALL seen          → renders nothing
 *   C3  one unseen alert                     → "1 new alert" + pkg@ver + verdict pill
 *   C4  many unseen alerts                   → "N new alerts", only first 3 listed
 *   C5  mixed seen/unseen                    → count reflects unseen only
 *   C6  a DANGEROUS unseen alert             → surfaced (honest invariant), danger tone
 *   C7  only non-DANGEROUS unseen alerts     → suspect tone, verdict NOT coerced to SAFE
 *   C8  click "Mark as seen"                 → POSTs /alerts/seen, alerts flip seen, notice hides
 *   C9  server error on mark-seen            → swallowed; notice stays (no fabricated hide)
 *   C10 DANGEROUS unseen alert beyond the    → danger tone still raised; the threat is
 *       visible first three                     derived from ALL unseen, not the slice
 */

import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderRoute, resetPanelStore, authedSeed } from "../../test/render.tsx";
import { setupPanelServer, server, http, HttpResponse } from "../../test/panel-server.ts";
import { makeAlert } from "../../test/panel-fixtures.ts";
import { usePanelStore } from "../../stores/panelStore.ts";
import { AlertsNotice } from "./AlertsNotice.tsx";

setupPanelServer();
beforeEach(() => resetPanelStore());

describe("AlertsNotice", () => {
  it("C1: no alerts renders nothing", () => {
    resetPanelStore(authedSeed({ alerts: [] }));
    const { container } = renderRoute(<AlertsNotice />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("C2: alerts that are all seen render nothing", () => {
    resetPanelStore(
      authedSeed({
        alerts: [makeAlert({ id: 1, seen: true }), makeAlert({ id: 2, seen: true })],
      }),
    );
    const { container } = renderRoute(<AlertsNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it("C3: one unseen alert shows the singular count, the package@version, and its verdict", () => {
    resetPanelStore(
      authedSeed({
        alerts: [
          makeAlert({ id: 10, packageName: "left-pad", version: "1.3.0", verdict: "SAFE", seen: false }),
        ],
      }),
    );
    renderRoute(<AlertsNotice />);
    const notice = screen.getByRole("status");
    expect(within(notice).getByText("1 new alert")).toBeInTheDocument();
    expect(within(notice).getByText("left-pad@1.3.0")).toBeInTheDocument();
    expect(within(notice).getByText("SAFE")).toBeInTheDocument();
  });

  it("C4: many unseen alerts show the plural count but list only the first three", () => {
    const alerts = [1, 2, 3, 4, 5].map((n) =>
      makeAlert({ id: n, packageName: `pkg-${n}`, version: `${n}.0.0`, verdict: "SAFE", seen: false }),
    );
    resetPanelStore(authedSeed({ alerts }));
    renderRoute(<AlertsNotice />);
    const notice = screen.getByRole("status");
    expect(within(notice).getByText("5 new alerts")).toBeInTheDocument();
    // Only the first three rows are rendered.
    expect(within(notice).getByText("pkg-1@1.0.0")).toBeInTheDocument();
    expect(within(notice).getByText("pkg-2@2.0.0")).toBeInTheDocument();
    expect(within(notice).getByText("pkg-3@3.0.0")).toBeInTheDocument();
    expect(within(notice).queryByText("pkg-4@4.0.0")).toBeNull();
    expect(within(notice).queryByText("pkg-5@5.0.0")).toBeNull();
    expect(within(notice).getAllByRole("listitem")).toHaveLength(3);
  });

  it("C5: a mix of seen and unseen counts only the unseen", () => {
    resetPanelStore(
      authedSeed({
        alerts: [
          makeAlert({ id: 1, seen: true }),
          makeAlert({ id: 2, packageName: "fresh-a", version: "2.0.0", verdict: "SAFE", seen: false }),
          makeAlert({ id: 3, seen: true }),
          makeAlert({ id: 4, packageName: "fresh-b", version: "3.0.0", verdict: "SAFE", seen: false }),
        ],
      }),
    );
    renderRoute(<AlertsNotice />);
    const notice = screen.getByRole("status");
    expect(within(notice).getByText("2 new alerts")).toBeInTheDocument();
    expect(within(notice).getByText("fresh-a@2.0.0")).toBeInTheDocument();
    expect(within(notice).getByText("fresh-b@3.0.0")).toBeInTheDocument();
    expect(within(notice).getAllByRole("listitem")).toHaveLength(2);
  });

  it("C6: a DANGEROUS unseen alert is surfaced (honest invariant), not swallowed", () => {
    resetPanelStore(
      authedSeed({
        alerts: [
          makeAlert({
            id: 20,
            packageName: "evil-pkg",
            version: "6.6.6",
            verdict: "DANGEROUS",
            seen: false,
          }),
        ],
      }),
    );
    renderRoute(<AlertsNotice />);
    const notice = screen.getByRole("status");
    // The threat verdict is rendered verbatim — never coerced to SAFE.
    expect(within(notice).getByText("DANGEROUS")).toBeInTheDocument();
    expect(within(notice).queryByText("SAFE")).toBeNull();
    expect(within(notice).getByText("evil-pkg@6.6.6")).toBeInTheDocument();
    // Danger tone reflects the presence of a DANGEROUS alert (stable class hook).
    expect(notice).toHaveClass("banner--danger");
  });

  it("C7: only non-DANGEROUS unseen alerts use the suspect tone (still not SAFE)", () => {
    resetPanelStore(
      authedSeed({
        alerts: [makeAlert({ id: 30, verdict: "SUSPECT", seen: false })],
      }),
    );
    renderRoute(<AlertsNotice />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("banner--suspect");
    expect(notice).not.toHaveClass("banner--danger");
  });

  it("C8: clicking Mark as seen POSTs, flips alerts to seen, and hides the notice", async () => {
    let posted = false;
    server.use(
      http.post("/api/panel/alerts/seen", () => {
        posted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    resetPanelStore(
      authedSeed({
        alerts: [
          makeAlert({ id: 40, packageName: "evil-pkg", version: "6.6.6", verdict: "DANGEROUS", seen: false }),
          makeAlert({ id: 41, seen: false }),
        ],
      }),
    );
    renderRoute(<AlertsNotice />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mark as seen" }));

    // The POST fired and the store flipped every alert to seen.
    await waitFor(() => expect(posted).toBe(true));
    await waitFor(() =>
      expect(usePanelStore.getState().alerts.every((a) => a.seen)).toBe(true),
    );
    // With no unseen alerts left the notice disappears.
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("C9: a failed mark-seen is swallowed and the notice stays (no fabricated hide)", async () => {
    server.use(
      http.post("/api/panel/alerts/seen", () => new HttpResponse(null, { status: 500 })),
    );
    resetPanelStore(
      authedSeed({ alerts: [makeAlert({ id: 50, verdict: "DANGEROUS", seen: false })] }),
    );
    renderRoute(<AlertsNotice />);

    fireEvent.click(screen.getByRole("button", { name: "Mark as seen" }));

    // markAlertsSeen only flips state after a resolved POST; on failure the alert
    // stays unseen and the honest DANGEROUS notice remains visible.
    await waitFor(() => expect(usePanelStore.getState().alerts[0].seen).toBe(false));
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(within(screen.getByRole("status")).getByText("DANGEROUS")).toBeInTheDocument();
  });

  it("C10: a DANGEROUS unseen alert beyond the visible first three still drives danger tone", () => {
    // Four SAFE unseen alerts push the DANGEROUS one to position 5 — past the
    // slice(0, 3) that governs the rendered list. Tone must be derived from ALL
    // unseen alerts, so a hidden threat is never silently downgraded to suspect.
    const alerts = [
      makeAlert({ id: 1, packageName: "pkg-1", version: "1.0.0", verdict: "SAFE", seen: false }),
      makeAlert({ id: 2, packageName: "pkg-2", version: "2.0.0", verdict: "SAFE", seen: false }),
      makeAlert({ id: 3, packageName: "pkg-3", version: "3.0.0", verdict: "SAFE", seen: false }),
      makeAlert({ id: 4, packageName: "pkg-4", version: "4.0.0", verdict: "SAFE", seen: false }),
      makeAlert({ id: 5, packageName: "evil-pkg", version: "6.6.6", verdict: "DANGEROUS", seen: false }),
    ];
    resetPanelStore(authedSeed({ alerts }));
    renderRoute(<AlertsNotice />);
    const notice = screen.getByRole("status");
    // The threat lives beyond the visible slice yet still raises the danger tone —
    // it is not downgraded to suspect just because its row is truncated away.
    expect(notice).toHaveClass("banner--danger");
    expect(notice).not.toHaveClass("banner--suspect");
    // The DANGEROUS row itself is not among the first three rendered rows.
    expect(within(notice).queryByText("evil-pkg@6.6.6")).toBeNull();
    expect(within(notice).getAllByRole("listitem")).toHaveLength(3);
  });
});
