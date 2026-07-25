/**
 * Component: the dashboard over a PARTIAL fetch — pages/Dashboard.tsx.
 *
 * The design doc's goal G6, tested where it can actually regress. The old page
 * fetched five resources through one `Promise.allSettled` and reduced them to one
 * `loading` plus one `error`, so any single failure either took the whole page
 * down or vanished. The specific lie: alerts failing left `alerts` at `[]`, the
 * banner returned `null`, and the reader concluded *no threats* from *no
 * knowledge*.
 *
 * Every case below fails one sub-fetch and asserts BOTH halves — that the failed
 * region says so by name, and that the regions which succeeded still render.
 * Asserting only the first would pass on a page that degraded everything.
 *
 * Input classes (one per degraded path):
 *  D1  alerts fail, repos succeed   — the repo list renders AND the alerts region is
 *                                     degraded and named. Silence is not an option.
 *  D2  repos fail, alerts succeed   — the alerts banner renders AND the repo region is
 *                                     degraded — never "No auditable repositories
 *                                     found", which is a claim about GitHub we cannot
 *                                     make from a failed read.
 *  D3  billing fails                — the plan ledger is degraded and named; the rest of
 *                                     the page is untouched.
 *  D4  installations fail           — the grid's empty copy depends on BOTH lists, so a
 *                                     failed installations read degrades the grid rather
 *                                     than picking one of the two sentences at random.
 *  D5  empty ≠ failed               — a successful read of zero repos renders the EMPTY
 *                                     state (achromatic, `data-state="empty"`), and the
 *                                     failed read renders `data-state="degraded"`. The
 *                                     two are distinguishable from the outside.
 *  D6  session read fails           — no sign-in card over an unreadable session, because
 *                                     that invites a click that cannot work.
 *
 * D7–D9 were added with the recomposition onto the design system, and D7 exists
 * because that recomposition ADDED empty-state call sites — the
 * app-not-configured branch and the "nothing matches this filter" branch. Every
 * new `EmptyState` is a new way for a failed read to end up looking like an
 * absence of threats, so the guarantee is re-pinned against the new surface
 * rather than assumed to have survived it.
 *
 *  D7  a failed sub-fetch renders NEITHER a confident view NOR an empty one — the
 *                                     rows that DID read are withheld (a grid over a
 *                                     partial read is a confident view over unknown
 *                                     data), and no `data-state="empty"` appears
 *                                     anywhere on the page.
 *  D8  the two adjacent no-content states stay opposite: "this server has no
 *                                     GitHub App" is a successful read and renders
 *                                     EMPTY; an unreadable session renders DEGRADED.
 *                                     Both are single-sentence grey-ish boxes to the
 *                                     eye, which is exactly why they need a test.
 *  D9  both themes render, and no colour is hardcoded — one class must work in
 *                                     light and dark, which is only true while every
 *                                     colour travels through a token.
 *
 * Blackbox: msw at the HTTP boundary, queries through the real client, assertions
 * on the accessibility tree and the `data-state` attributes the design system
 * plants for exactly this purpose.
 */

import { configure, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { expectNoHardcodedColour } from "../components/panel/theme-probe.ts";
import {
  alert,
  auditSet,
  billingResponse,
  clearAbsoluteApiBase,
  panelRepo,
  renderWithClient,
  SESSION_USER,
  useAbsoluteApiBase,
} from "../lib/test-harness.tsx";
import { Dashboard } from "./Dashboard.tsx";

const server = setupServer();

// Six real fetches, six schema parses and a full page render per case, with the
// suite running four workers wide. RTL's 1s default is not a meaningful budget
// for that, and a timeout here reads as a false "the region never resolved".
configure({ asyncUtilTimeout: 5000 });

beforeAll(() => {
  useAbsoluteApiBase();
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  clearAbsoluteApiBase();
});

const REPOS = [panelRepo({ id: 5, name: "widget", fullName: "acme/widget", lastScan: auditSet() })];

/** Every panel route answering healthily. Each test overrides exactly the one it
 * is failing, so a passing assertion cannot be an accident of a second failure. */
function healthy(over: {
  repos?: () => Response;
  alerts?: () => Response;
  billing?: () => Response;
  orgs?: () => Response;
} = {}) {
  server.use(
    http.get("/api/me", () => HttpResponse.json({ user: SESSION_USER })),
    http.get("/api/panel/orgs", over.orgs ?? (() =>
      HttpResponse.json({
        installations: [{ id: 1, accountLogin: "acme", accountType: "Organization", suspended: false }],
        installUrl: "https://github.com/apps/npmguard/installations/new",
      }))),
    http.get("/api/panel/repos", over.repos ?? (() => HttpResponse.json({ repos: REPOS }))),
    http.get("/api/panel/alerts", over.alerts ?? (() => HttpResponse.json({ alerts: [alert()] }))),
    http.get("/api/panel/billing", over.billing ?? (() => HttpResponse.json(billingResponse()))),
    http.get("/api/panel/public-repos", () => HttpResponse.json({ scans: [] })),
  );
}

const fails = (status: number) => () => HttpResponse.json({ error: "upstream" }, { status });

describe("Dashboard — D1 alerts fail while repos succeed", () => {
  it("D1: the repo list still renders, and the alerts region says it is unavailable", async () => {
    healthy({ alerts: fails(502) });
    renderWithClient(<Dashboard />);

    // The half that worked is still shown — degrading everything would be a
    // different bug with the same shape.
    expect(await screen.findByText("widget")).toBeInTheDocument();

    // The half that failed NAMES itself. This is the assertion the old page could
    // not pass: it rendered nothing at all here.
    const degraded = await screen.findByText(/Alerts feed unavailable/);
    expect(degraded).toBeInTheDocument();
    // …and it is unmistakably not an empty state.
    expect(degraded.closest('[data-state="degraded"]')).not.toBeNull();
  });
});

describe("Dashboard — D2 repos fail while alerts succeed", () => {
  it("D2: the alerts banner renders, and the repo region never claims 'no repositories'", async () => {
    healthy({ repos: fails(500) });
    renderWithClient(<Dashboard />);

    expect(await screen.findByText(/left-pad/)).toBeInTheDocument();
    expect(await screen.findByText(/Repositories unavailable/)).toBeInTheDocument();
    // The empty copy is a claim about GitHub. A failed read cannot support it.
    expect(screen.queryByText(/No auditable repositories found/)).toBeNull();
    expect(screen.queryByText(/Install NpmGuard on a GitHub account/)).toBeNull();
  });
});

describe("Dashboard — D3 billing fails", () => {
  it("D3: the plan ledger degrades by name while the rest of the page stands", async () => {
    healthy({ billing: fails(503) });
    renderWithClient(<Dashboard />);

    expect(await screen.findByText("widget")).toBeInTheDocument();
    expect(await screen.findByText(/Plan & usage unavailable/)).toBeInTheDocument();
  });
});

describe("Dashboard — D4 installations fail", () => {
  it("D4: the grid degrades rather than guessing which empty sentence is true", async () => {
    healthy({ orgs: fails(502), repos: () => HttpResponse.json({ repos: [] }) });
    renderWithClient(<Dashboard />);

    expect(await screen.findByText(/Your GitHub workspace unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No auditable repositories found/)).toBeNull();
  });
});

describe("Dashboard — D5 an empty read and a failed read stay distinguishable", () => {
  it("D5: zero repositories renders the EMPTY state, not a degraded one", async () => {
    healthy({ repos: () => HttpResponse.json({ repos: [] }) });
    renderWithClient(<Dashboard />);

    const empty = await screen.findByText(/No auditable repositories found/);
    expect(empty.closest('[data-state="empty"]')).not.toBeNull();
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });

  it("D5: a failed repositories read renders the DEGRADED state, not an empty one", async () => {
    healthy({ repos: fails(500) });
    renderWithClient(<Dashboard />);

    await screen.findByText(/Repositories unavailable/);
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
    expect(document.querySelector('[data-state="degraded"]')).not.toBeNull();
  });
});

describe("Dashboard — D6 an unreadable session is not a signed-out session", () => {
  it("D6: a 500 on /me names the failure instead of offering a sign-in that cannot work", async () => {
    server.use(http.get("/api/me", fails(500)));
    renderWithClient(<Dashboard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Your GitHub session/);
    expect(screen.queryByText(/Sign in with GitHub/)).toBeNull();
  });

  it("D6: a 401 IS a signed-out session, and does render the sign-in card", async () => {
    server.use(http.get("/api/me", () => HttpResponse.json({ error: "Not signed in" }, { status: 401 })));
    renderWithClient(<Dashboard />);

    expect(await screen.findByText(/Sign in with GitHub/)).toBeInTheDocument();
  });
});

describe("Dashboard — D7 a partial read is neither confident nor empty", () => {
  it("D7: rows that DID read are withheld, and nothing renders as empty", async () => {
    // The discriminating shape, and the one the recomposition could plausibly
    // break: repos SUCCEEDS with a row while installations fails. The grid's copy
    // is a product of both reads, so a grid drawn from repos alone would be a
    // confident view over an unknown denominator.
    healthy({ orgs: fails(502) });
    renderWithClient(<Dashboard />);

    await screen.findByText(/Your GitHub workspace unavailable/);
    // The row exists in the response and is deliberately not shown.
    expect(screen.queryByText("widget")).toBeNull();
    // And none of the page's empty states — including the two the recomposition
    // added — is reachable from here.
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
    expect(document.querySelector('[data-state="degraded"]')).not.toBeNull();
  });

  it("D7: the filter empty-state cannot be reached from a failed read", async () => {
    // "No repositories match this view" is minted from `loaded(visible)`, which
    // can only be constructed from rows in hand. Asserted from the outside: on a
    // failed read that copy must be absent, not merely unlikely.
    healthy({ repos: fails(500) });
    renderWithClient(<Dashboard />);

    await screen.findByText(/Repositories unavailable/);
    expect(screen.queryByText(/No repositories match this view/)).toBeNull();
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
  });
});

describe("Dashboard — D8 an unconfigured server is a FACT, not a failure", () => {
  it("D8: a 503 renders the achromatic empty state, never the degraded one", async () => {
    // 503 on /me means the deployment has no GitHub App. `fetchSession` turns that
    // into `{appEnabled: false}` — a successful read of a real fact — so hatching
    // it would say "we don't know" about the one thing we know for certain.
    server.use(http.get("/api/me", fails(503)));
    renderWithClient(<Dashboard />);

    const empty = await screen.findByText(/not configured on this server/);
    expect(empty.closest('[data-state="empty"]')).not.toBeNull();
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
    // No sign-in either: no amount of signing in fixes a missing App.
    expect(screen.queryByText(/Sign in with GitHub/)).toBeNull();
  });

  it("D8: an unreadable session renders the degraded state, never the empty one", async () => {
    // The mirror. These two branches sit next to each other in the page and read
    // almost identically to the eye, which is the whole reason for the pair.
    server.use(http.get("/api/me", fails(500)));
    renderWithClient(<Dashboard />);

    await screen.findByRole("alert");
    expect(document.querySelector('[data-state="degraded"]')).not.toBeNull();
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
  });
});

describe("Dashboard — D9 both themes", () => {
  afterEach(() => document.documentElement.classList.remove("dark", "light"));

  for (const theme of ["light", "dark"] as const) {
    it(`D9: renders under an explicit .${theme} stamp`, async () => {
      // The token layer's whole premise is that ONE class works in both themes,
      // because `@theme inline` makes utilities reference `var(--ng-…)` rather
      // than a copied value. So the useful assertion is not "the pixels differ"
      // (jsdom computes no Tailwind) but "the same markup serves both, and no
      // colour was hardcoded past the token layer" — §6's first checklist item.
      document.documentElement.classList.add(theme);
      healthy();
      renderWithClient(<Dashboard />);

      expect(await screen.findByText("widget")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Repository posture" })).toBeInTheDocument();
      expectNoHardcodedColour();
    });
  }

  it("D9: a degraded region is token-driven in both themes too", async () => {
    // The degraded state is the one with an inline `style` (the hatch), so it is
    // where a raw hex would most plausibly be introduced — and it is the state
    // whose meaning depends most on being legible.
    document.documentElement.classList.add("dark");
    healthy({ repos: fails(500) });
    renderWithClient(<Dashboard />);

    await screen.findByText(/Repositories unavailable/);
    const hatched = document.querySelector('[data-state="degraded"] [style*="gradient"]');
    expect(hatched?.getAttribute("style")).toMatch(/var\(--ng-/);
    expectNoHardcodedColour();
  });
});
