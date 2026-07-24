/**
 * RepoCard — blackbox component-integration tests.
 *
 * RepoCard renders a single repo tile: identity + open aria-label, private /
 * protected tags, a ScanStatus summary of the last scan, and an action footer
 * (Run audit, Protect/unprotect, open details). Actions call the singleton
 * panel store; per-repo errors render inline + dismissible.
 *
 * Equivalence classes (inputs → observable output/effect):
 *   C1  identity: owner + name + aria-label "Open <fullName>"
 *   C2  private repo renders the Private tag; a public repo does not
 *   C3  protected repo renders the Protected tag + "Continuous" monitoring
 *   C4  last scan done + SAFE → SAFE verdict pill
 *   C5  last scan done + DANGEROUS → DANGEROUS pill, NEVER coerced to SAFE (honest invariant)
 *   C6  last scan running → "Scanning" progressbar; audit button disabled
 *   C7  last scan failed → honest "Scan failed" (not a fabricated verdict)
 *   C8  no last scan (null) → "Not audited" (pending/never distinct from a verdict)
 *   C9  click Run audit → POST scan, then navigate to /repo/<owner>/<name>
 *   C10 click Protect → POST …/protect (handler hit)
 *   C11 protected repo: click Protected → DELETE …/protect (unprotect, handler hit)
 *   C12 seeded repoActionErrors[id] → role=alert with the message + dismiss clears it
 *   C13 click open-details arrow → navigate to /repo/<owner>/<name>
 *   C14 last scan done but verdict null → honest "Done", NEVER a fabricated SAFE (pending-verdict invariant)
 *   C15 single-dependency scan → singular "dependency" (0/1/many plural boundary)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import { renderRoute, resetPanelStore } from "../../test/render.tsx";
import { setupPanelServer, server, http, HttpResponse } from "../../test/panel-server.ts";
import { makeRepo, makeScan } from "../../test/panel-fixtures.ts";
import { RepoCard } from "./RepoCard.tsx";

setupPanelServer();
beforeEach(() => resetPanelStore());

describe("RepoCard", () => {
  it("C1: renders owner + name and an 'Open <fullName>' aria-label", () => {
    const repo = makeRepo({ owner: "acme", name: "widgets" });
    renderRoute(<RepoCard repo={repo} />);
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText("widgets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open acme/widgets" })).toBeInTheDocument();
  });

  it("C2: a private repo shows the Private tag; a public one does not", () => {
    const { unmount } = renderRoute(<RepoCard repo={makeRepo({ private: true })} />);
    expect(screen.getByText("Private")).toBeInTheDocument();
    unmount();
    renderRoute(<RepoCard repo={makeRepo({ private: false })} />);
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
  });

  it("C3: a protected repo shows the Protected tag and Continuous monitoring", () => {
    renderRoute(<RepoCard repo={makeRepo({ protected: true })} />);
    // The tag span (there is also a Protect *button*; both carry the word).
    const tags = screen.getAllByText("Protected");
    expect(tags.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Continuous")).toBeInTheDocument();
  });

  it("C4: a done SAFE scan renders the SAFE verdict pill", () => {
    const repo = makeRepo({ lastScan: makeScan({ status: "done", verdict: "SAFE" }) });
    renderRoute(<RepoCard repo={repo} />);
    expect(screen.getByText("SAFE")).toBeInTheDocument();
    expect(screen.queryByText("DANGEROUS")).not.toBeInTheDocument();
  });

  it("C5: a done DANGEROUS scan renders DANGEROUS and is NEVER coerced to SAFE", () => {
    const repo = makeRepo({ lastScan: makeScan({ status: "done", verdict: "DANGEROUS" }) });
    renderRoute(<RepoCard repo={repo} />);
    expect(screen.getByText("DANGEROUS")).toBeInTheDocument();
    // Honest-verdict invariant: a dangerous scan must not surface as SAFE.
    expect(screen.queryByText("SAFE")).not.toBeInTheDocument();
  });

  it("C6: a running scan shows a Scanning progressbar and disables the audit button", () => {
    const repo = makeRepo({
      lastScan: makeScan({ status: "running", total: 10, cached: 3, audited: 0, failed: 0, verdict: null }),
    });
    renderRoute(<RepoCard repo={repo} />);
    expect(screen.getByText("Scanning")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Scan progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "10");
    expect(screen.getByRole("button", { name: "Scanning…" })).toBeDisabled();
  });

  it("C7: a failed scan renders an honest 'Scan failed', not a verdict", () => {
    const repo = makeRepo({ lastScan: makeScan({ status: "failed", verdict: null }) });
    renderRoute(<RepoCard repo={repo} />);
    expect(screen.getByText("Scan failed")).toBeInTheDocument();
    expect(screen.queryByText("SAFE")).not.toBeInTheDocument();
    expect(screen.queryByText("DANGEROUS")).not.toBeInTheDocument();
  });

  it("C8: no last scan renders 'Not audited' (never a fabricated verdict)", () => {
    renderRoute(<RepoCard repo={makeRepo({ lastScan: null })} />);
    expect(screen.getByText("Not audited")).toBeInTheDocument();
    expect(screen.queryByText("SAFE")).not.toBeInTheDocument();
  });

  it("C9: clicking Run audit POSTs the scan and navigates to the repo detail route", async () => {
    let scanHit = false;
    server.use(
      http.post("/api/panel/repo/:repoId/scan", () => {
        scanHit = true;
        return HttpResponse.json({ scanId: 777 });
      }),
    );
    const repo = makeRepo({ owner: "acme", name: "widgets", lastScan: null });
    renderRoute(<RepoCard repo={repo} />);

    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));

    await waitFor(() => expect(scanHit).toBe(true));
    // scanId !== null → navigate to /repo/acme/widgets
    expect(await screen.findByTestId("route-repo-detail")).toBeInTheDocument();
  });

  it("C10: clicking Protect POSTs the protect route", async () => {
    let protectHit = false;
    server.use(
      http.post("/api/panel/repo/:repoId/protect", () => {
        protectHit = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderRoute(<RepoCard repo={makeRepo({ protected: false })} />);

    fireEvent.click(screen.getByRole("button", { name: "Protect" }));

    await waitFor(() => expect(protectHit).toBe(true));
  });

  it("C11: on a protected repo, clicking Protected DELETEs the protect route (unprotect)", async () => {
    let unprotectHit = false;
    server.use(
      http.delete("/api/panel/repo/:repoId/protect", () => {
        unprotectHit = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderRoute(<RepoCard repo={makeRepo({ protected: true })} />);

    fireEvent.click(screen.getByRole("button", { name: "Protected" }));

    await waitFor(() => expect(unprotectHit).toBe(true));
  });

  it("C12: a seeded repoActionErrors entry renders a role=alert error that Dismiss clears", async () => {
    const repo = makeRepo({ id: 4321 });
    resetPanelStore({
      repoActionErrors: { 4321: { action: "audit", message: "Could not start the audit" } },
    });
    renderRoute(<RepoCard repo={repo} />);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Could not start the audit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("C13: clicking the open-details arrow navigates to the repo detail route", async () => {
    const repo = makeRepo({ owner: "acme", name: "widgets" });
    renderRoute(<RepoCard repo={repo} />);

    fireEvent.click(screen.getByRole("button", { name: "Open details for acme/widgets" }));

    expect(await screen.findByTestId("route-repo-detail")).toBeInTheDocument();
  });

  it("C14: a done scan with NO verdict renders an honest 'Done', never a fabricated SAFE", () => {
    // The engine can mark a scan done while the verdict rollup is still UNKNOWN
    // (null on the wire). ScanStatus falls back to a neutral "Done" pill — the
    // honest-verdict invariant forbids coercing that absence into green.
    const repo = makeRepo({ lastScan: makeScan({ status: "done", verdict: null }) });
    renderRoute(<RepoCard repo={repo} />);
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.queryByText("SAFE")).not.toBeInTheDocument();
    expect(screen.queryByText("DANGEROUS")).not.toBeInTheDocument();
  });

  it("C15: a single-dependency scan reads 'dependency' (singular), not 'dependencies'", () => {
    const repo = makeRepo({ lastScan: makeScan({ status: "done", verdict: "SAFE", total: 1 }) });
    renderRoute(<RepoCard repo={repo} />);
    expect(screen.getByText(/^1 dependency ·/)).toBeInTheDocument();
    expect(screen.queryByText(/dependencies/)).not.toBeInTheDocument();
  });
});
