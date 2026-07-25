/**
 * Component: the replay gallery — pages/Replays.tsx.
 *
 * The page is a list of links, so the things worth pinning are the ones that make
 * a link either honest or a lie:
 *
 *  R1  a listed audit links to /audit/{auditId}, NOT to /package/{name}. The
 *      package-keyed report store keeps only the LAST audit of a pair, so a
 *      name-keyed href silently repoints the next time that package is audited —
 *      and nothing on screen would change to say so. This is the assertion that
 *      fails if someone "simplifies" the row to reuse the registry's link.
 *  R2  a failed read never renders the empty state. "No audits have finished"
 *      would be a claim about the engine made from no knowledge of it, which is
 *      the same lie the dashboard rework exists to prevent.
 *  R3  a successful read of zero audits DOES render the empty state, with a way
 *      to start an audit rather than a dead end.
 *  R4  a null version renders as a stated absence, not as a blank cell that reads
 *      as a rendering bug.
 *  R5  the verdict is announced as a word, so the row survives without colour.
 *
 * Blackbox: msw at the HTTP boundary, the real query client, assertions on the
 * accessibility tree and the `data-state` attributes the design system plants.
 */

import type { ReplayEntry } from "@npmguard/shared";
import { configure, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearAbsoluteApiBase,
  renderWithClient,
  useAbsoluteApiBase,
} from "../lib/test-harness.tsx";
import { Replays } from "./Replays.tsx";

const server = setupServer();

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

function replay(over: Partial<ReplayEntry> = {}): ReplayEntry {
  return {
    auditId: "3f1c6a2e-0000-4000-8000-000000000001",
    packageName: "chalk",
    version: "4.0.1",
    verdict: "SAFE",
    durationMs: 42_000,
    recordedAt: "2026-07-24T09:15:00.000Z",
    ...over,
  };
}

const serve = (replays: ReplayEntry[]) =>
  server.use(http.get("/api/replays", () => HttpResponse.json({ replays })));

describe("Replays — R1 the permalink is the audit id", () => {
  it("R1: a row links to /audit/{auditId}, never to the package-keyed report", async () => {
    const entry = replay();
    serve([entry]);
    renderWithClient(<Replays />);

    const link = await screen.findByRole("link", { name: /replay the audit of chalk/i });
    expect(link).toHaveAttribute("href", `/audit/${entry.auditId}`);
    // Stated as a negative too: /package/chalk resolves to whichever audit of
    // chalk was stored LAST, which is a different run than the one on this row.
    expect(link.getAttribute("href")).not.toContain("/package/");
  });
});

describe("Replays — R2 a failed read is not an empty gallery", () => {
  it("R2: the failure is named, and 'no audits have finished' is never rendered", async () => {
    server.use(http.get("/api/replays", () => HttpResponse.json({ error: "upstream" }, { status: 502 })));
    renderWithClient(<Replays />);

    const degraded = await screen.findByText(/Replays/i, {
      selector: '[data-state="degraded"] *',
    });
    expect(degraded).toBeInTheDocument();
    expect(screen.queryByText(/No audits have finished/i)).toBeNull();
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
  });
});

describe("Replays — R3 an empty gallery offers a way out", () => {
  it("R3: zero audits renders the empty state with an audit launcher", async () => {
    serve([]);
    renderWithClient(<Replays />);

    const message = await screen.findByText(/No audits have finished on this engine yet/i);
    expect(message.closest('[data-state="empty"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: /audit a package/i })).toHaveAttribute(
      "href",
      "/packages",
    );
  });
});

describe("Replays — R4 an unresolved version says so", () => {
  it("R4: a null version renders as 'unversioned', not as a blank cell", async () => {
    serve([replay({ version: null })]);
    renderWithClient(<Replays />);

    expect(await screen.findByText("unversioned")).toBeInTheDocument();
  });
});

describe("Replays — R5 the verdict survives without colour", () => {
  it("R5: the verdict is a word in the tree, not only a hue", async () => {
    serve([replay({ auditId: "safe-one" }), replay({ auditId: "bad-one", verdict: "DANGEROUS" })]);
    renderWithClient(<Replays />);

    expect(await screen.findByText("DANGEROUS")).toBeInTheDocument();
    expect(screen.getByText("SAFE")).toBeInTheDocument();
  });
});
