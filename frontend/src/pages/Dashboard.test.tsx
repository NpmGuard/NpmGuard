/**
 * Dashboard (GitHub workspace) — blackbox component-integration tests.
 *
 * Class map (equivalence classes of the dashboard's input surface):
 *   C1  gate/loading    — !userLoaded → spinner (role=status "Loading"), NOT the login gate.
 *   C2  gate/anon       — userLoaded && !user → "Connect your GitHub workspace" + GitHub sign-in link.
 *   C3  authed boot     — authed + repos → hero "Repository posture", a RepoCard per repo, subsections mount.
 *   C4  filter counts   — All/Protected/Not audited/Attention show correct counts.
 *   C5  filter narrows  — clicking a filter (aria-pressed) narrows the visible cards.
 *   C6  search fullName  — search box filters by fullName.
 *   C7  search branch    — search box filters by default branch.
 *   C8  match-nothing    — a filter/search matching nothing → "No repositories match this view" + Reset.
 *   C9  empty/no-install  — repos ∅ + installations ∅ → "Install NpmGuard on a GitHub account".
 *   C10 empty/installed   — repos ∅ + installations present → "No auditable repositories found".
 *   C11 empty/loading     — loading && repos ∅ → "Loading repositories…".
 *   C12 public-audit btn  — button shows only with ≥1 billing account; click opens PublicAuditDialog.
 *   C13 error banner      — a failing /api/panel/orgs → role=alert banner + "Try again" (never a fake grid).
 *   C14 billing/success   — ?billing=success → role=status "Payment confirmed", dismissable.
 *   C15 billing/cancelled — ?billing=cancelled → role=status "Checkout cancelled", dismissable.
 *   C16 paywall           — store.paywall seeded → UpgradeDialog renders.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderRoute, resetPanelStore, authedSeed } from "../test/render.tsx";
import {
  setupPanelServer,
  useHappyPanel,
  server,
  http,
  HttpResponse,
  delay,
} from "../test/panel-server.ts";
import { makeRepo, makeScan, makeOrgs, makeBilling, makeCapBody } from "../test/panel-fixtures.ts";
import { githubLoginUrl } from "../lib/panel-api.ts";
import { Dashboard } from "./Dashboard.tsx";

setupPanelServer();

afterEach(() => {
  // The billing-notice effect reads window.location.search directly and strips
  // it via replaceState; reset the URL so classes don't bleed into each other.
  window.history.replaceState(null, "", "/");
});

// A repo set with one representative per grid dimension.
const repoProtected = makeRepo({
  id: 1,
  owner: "acme",
  name: "protected-svc",
  protected: true,
  lastScan: makeScan({ verdict: "SAFE", status: "done" }),
});
const repoUnscanned = makeRepo({
  id: 2,
  owner: "acme",
  name: "fresh-lib",
  defaultBranch: "release-2x",
  lastScan: null,
});
const repoFailed = makeRepo({
  id: 3,
  owner: "acme",
  name: "build-broke",
  lastScan: makeScan({ status: "failed", verdict: null }),
});
const repoDangerous = makeRepo({
  id: 4,
  owner: "acme",
  name: "risky-dep",
  lastScan: makeScan({ status: "done", verdict: "DANGEROUS" }),
});
const variedRepos = [repoProtected, repoUnscanned, repoFailed, repoDangerous];

describe("Dashboard", () => {
  it("C1: pre-load (!userLoaded) shows a loading spinner, not the login gate", () => {
    resetPanelStore(); // default: userLoaded false, user null → no boot, no fetch
    renderRoute(<Dashboard />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("Connect your GitHub workspace")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Repository posture" })).not.toBeInTheDocument();
  });

  it("C2: userLoaded && !user renders the GitHub connect gate with a sign-in link", () => {
    resetPanelStore({ userLoaded: true }); // loaded but unauthenticated → no boot
    renderRoute(<Dashboard />);

    expect(
      screen.getByRole("heading", { name: "Connect your GitHub workspace" }),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Sign in with GitHub" });
    expect(link).toHaveAttribute("href", githubLoginUrl());
  });

  it("C3: authenticated boot renders the posture hero, a card per repo, and the subsections", async () => {
    useHappyPanel({ repos: variedRepos });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    // Hero renders as soon as the user is known.
    expect(screen.getByRole("heading", { name: "Repository posture" })).toBeInTheDocument();

    // The grid is fetched on boot.
    await waitFor(() =>
      expect(screen.getByLabelText("Open acme/protected-svc")).toBeInTheDocument(),
    );
    for (const repo of variedRepos) {
      expect(screen.getByLabelText(`Open ${repo.fullName}`)).toBeInTheDocument();
    }

    // Always-mounted subsections are present (lightly — they own their own tests).
    // (PublicAuditHistory renders null with no public scans, so it is not asserted here.)
    expect(screen.getByRole("region", { name: "Plan and usage" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Portfolio posture" })).toBeInTheDocument();
  });

  it("C4: filter buttons report the correct per-class counts", async () => {
    useHappyPanel({ repos: variedRepos });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    await waitFor(() => expect(screen.getByRole("button", { name: "All 4" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Protected 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not audited 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attention 2" })).toBeInTheDocument();
  });

  it("C5: clicking a filter presses it and narrows the visible cards", async () => {
    useHappyPanel({ repos: variedRepos });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const attentionBtn = await screen.findByRole("button", { name: "Attention 2" });
    fireEvent.click(attentionBtn);

    expect(attentionBtn).toHaveAttribute("aria-pressed", "true");
    // Only the two attention repos (failed + DANGEROUS) survive.
    expect(screen.getByLabelText("Open acme/build-broke")).toBeInTheDocument();
    expect(screen.getByLabelText("Open acme/risky-dep")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open acme/protected-svc")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Open acme/fresh-lib")).not.toBeInTheDocument();
  });

  it("C6: search filters the grid by fullName", async () => {
    useHappyPanel({ repos: variedRepos });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const box = await screen.findByLabelText("Search repositories");
    fireEvent.change(box, { target: { value: "risky" } });

    expect(screen.getByLabelText("Open acme/risky-dep")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open acme/protected-svc")).not.toBeInTheDocument();
  });

  it("C7: search filters the grid by default branch", async () => {
    useHappyPanel({ repos: variedRepos });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const box = await screen.findByLabelText("Search repositories");
    fireEvent.change(box, { target: { value: "release-2x" } }); // only repoUnscanned's branch

    expect(screen.getByLabelText("Open acme/fresh-lib")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open acme/risky-dep")).not.toBeInTheDocument();
  });

  it("C8: a search matching nothing shows the honest empty view + Reset", async () => {
    useHappyPanel({ repos: variedRepos });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const box = await screen.findByLabelText("Search repositories");
    fireEvent.change(box, { target: { value: "zzz-no-such-repo" } });

    expect(screen.getByText("No repositories match this view")).toBeInTheDocument();
    const reset = screen.getByRole("button", { name: /Reset/ });
    fireEvent.click(reset);

    // Reset restores the full grid.
    await waitFor(() =>
      expect(screen.getByLabelText("Open acme/risky-dep")).toBeInTheDocument(),
    );
  });

  it("C9: repos ∅ + installations ∅ prompts to install NpmGuard", async () => {
    useHappyPanel({ repos: [], orgs: makeOrgs({ installations: [] }) });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByText("Install NpmGuard on a GitHub account")).toBeInTheDocument(),
    );
    expect(screen.queryByText("No auditable repositories found")).not.toBeInTheDocument();
  });

  it("C10: repos ∅ with an installation present shows 'No auditable repositories found'", async () => {
    useHappyPanel({ repos: [] }); // default orgs has one installation
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByText("No auditable repositories found")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Install NpmGuard on a GitHub account")).not.toBeInTheDocument();
  });

  it("C11: loading with no repos yet shows 'Loading repositories…'", async () => {
    // Hang orgs so refresh() stays in-flight and loading stays true.
    useHappyPanel();
    server.use(
      http.get("/api/panel/orgs", async () => {
        await delay("infinite");
        return HttpResponse.json(makeOrgs());
      }),
    );
    resetPanelStore(authedSeed({ loading: true }));
    renderRoute(<Dashboard />);

    expect(await screen.findByText("Loading repositories…")).toBeInTheDocument();
  });

  it("C12: the 'Audit public repo' button appears with a billing account and opens the dialog", async () => {
    useHappyPanel({ repos: [repoProtected] });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const auditBtn = await screen.findByRole("button", { name: /Audit public repo/ });
    fireEvent.click(auditBtn);

    expect(
      await screen.findByRole("dialog", { name: "Audit a public repository" }),
    ).toBeInTheDocument();
  });

  it("C12: the 'Audit public repo' button is hidden when billing has no accounts", async () => {
    useHappyPanel({ repos: [repoProtected], billing: makeBilling({ accounts: [] }) });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByLabelText("Open acme/protected-svc")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Audit public repo/ })).not.toBeInTheDocument();
  });

  it("C13: a failing orgs load renders an honest error banner with 'Try again', never a grid", async () => {
    useHappyPanel({ repos: variedRepos });
    server.use(
      http.get("/api/panel/orgs", () =>
        HttpResponse.json({ message: "Workspace unreachable" }, { status: 500 }),
      ),
    );
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Workspace unreachable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // The grid is NOT fabricated on error.
    expect(screen.queryByLabelText("Open acme/risky-dep")).not.toBeInTheDocument();
  });

  it("C13: a failing repos load errors honestly and never fabricates a reassuring empty-state", async () => {
    // Orgs succeeds (installation present) but the repos fetch — fatal to the
    // grid — fails. The store sets `error` with repos still empty. The dashboard
    // must show the alert banner and must NOT render a calming "No auditable
    // repositories found" / "Install NpmGuard" verdict over a load that failed:
    // the `&& !error` guards are an honest-verdict invariant, not decoration.
    useHappyPanel(); // default orgs → one installation
    server.use(
      http.get("/api/panel/repos", () =>
        HttpResponse.json({ message: "Repository index unavailable" }, { status: 500 }),
      ),
    );
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Repository index unavailable")).toBeInTheDocument();
    // No fabricated "nothing to see here" reassurance masking the failure.
    expect(screen.queryByText("No auditable repositories found")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Install NpmGuard on a GitHub account"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Loading repositories…")).not.toBeInTheDocument();
  });

  it("C14: ?billing=success shows a dismissable 'Payment confirmed' notice", async () => {
    window.history.replaceState(null, "", "/?billing=success");
    useHappyPanel();
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const notice = await screen.findByText(/Payment confirmed/);
    expect(notice.closest('[role="status"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    await waitFor(() =>
      expect(screen.queryByText(/Payment confirmed/)).not.toBeInTheDocument(),
    );
  });

  it("C15: ?billing=cancelled shows a dismissable 'Checkout cancelled' notice", async () => {
    window.history.replaceState(null, "", "/?billing=cancelled");
    useHappyPanel();
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    const notice = await screen.findByText(/Checkout cancelled/);
    expect(notice.closest('[role="status"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    await waitFor(() =>
      expect(screen.queryByText(/Checkout cancelled/)).not.toBeInTheDocument(),
    );
  });

  it("C16: a seeded paywall renders the UpgradeDialog", async () => {
    useHappyPanel();
    resetPanelStore(authedSeed({ paywall: makeCapBody() }));
    renderRoute(<Dashboard />);

    expect(await screen.findByRole("dialog", { name: "Upgrade to Pro" })).toBeInTheDocument();
  });
});
