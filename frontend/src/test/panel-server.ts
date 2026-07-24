/**
 * MSW server + handler factory for the GitHub panel routes.
 *
 * The panel has no hermetic replay mode (its data comes from live GitHub via
 * OAuth), so these component-integration tests mock the engine at the HTTP
 * boundary — the SAME boundary the real app crosses. Handlers are registered
 * ORIGIN-RELATIVE (`/api/panel/…`) and matched against the jsdom origin;
 * `setupPanelServer()` pins `apiBase()` to `${origin}/api` so undici sees an
 * absolute URL while the handlers stay origin-relative (mirrors api.test.ts).
 *
 * `panelHandlers(data)` gives every GET route a valid default so a Dashboard
 * boot (`refresh()` → orgs + repos + alerts + billing + public-repos) resolves
 * without per-test wiring; a test overrides only the route its class exercises,
 * either through `data` or with `server.use(http.…)` for status/mutation cases.
 */

import { afterAll, afterEach, beforeAll } from "vitest";
import { HttpResponse, delay, http } from "msw";
import { setupServer } from "msw/node";
import type {
  Alert,
  BillingResponse,
  OrgsResponse,
  PanelRepo,
  PublicScan,
  RepoDetailResponse,
  SessionUser,
} from "../lib/engine-types.ts";
import {
  makeBilling,
  makeOrgs,
  makeRepoDetail,
  makeUser,
} from "./panel-fixtures.ts";

export { HttpResponse, delay, http };

export const server = setupServer();

/** Wire the MSW lifecycle + pin the API base to the jsdom origin. Call once at
 * the top level of a panel test file. */
export function setupPanelServer(): void {
  beforeAll(() => {
    window.__NPMGUARD_CONFIG__ = { apiBase: `${window.location.origin}/api` };
    server.listen({ onUnhandledRequest: "error" });
  });
  afterEach(() => server.resetHandlers());
  afterAll(() => {
    server.close();
    delete window.__NPMGUARD_CONFIG__;
  });
}

export interface PanelData {
  user?: SessionUser | null;
  orgs?: OrgsResponse;
  repos?: PanelRepo[];
  alerts?: Alert[];
  billing?: BillingResponse | null;
  publicScans?: PublicScan[];
  /** Static detail, or a resolver keyed by the route's owner/name. */
  repoDetail?: RepoDetailResponse | ((owner: string, name: string) => RepoDetailResponse);
}

/** A full happy-path handler set. Every GET route answers 200 with a valid
 * (possibly empty) body; mutation routes answer benign successes. Compose with
 * `server.use(...)` in a test to override a single route with an error/branch. */
export function panelHandlers(data: PanelData = {}) {
  const {
    user = makeUser(),
    orgs = makeOrgs(),
    repos = [],
    alerts = [],
    billing = makeBilling(),
    publicScans = [],
    repoDetail,
  } = data;

  const resolveDetail = (owner: string, name: string): RepoDetailResponse =>
    typeof repoDetail === "function"
      ? repoDetail(owner, name)
      : (repoDetail ?? makeRepoDetail({ repo: makeRepoDetail().repo }));

  return [
    http.get("/api/me", () => HttpResponse.json({ user })),
    http.post("/api/auth/logout", () => HttpResponse.json({ ok: true })),

    http.get("/api/panel/orgs", () => HttpResponse.json(orgs)),
    http.get("/api/panel/repos", () => HttpResponse.json({ repos })),
    http.get("/api/panel/alerts", () => HttpResponse.json({ alerts })),
    http.post("/api/panel/alerts/seen", () => HttpResponse.json({ ok: true })),
    http.get("/api/panel/billing", () =>
      billing === null ? new HttpResponse(null, { status: 404 }) : HttpResponse.json(billing),
    ),

    http.get("/api/panel/public-repos", () => HttpResponse.json({ scans: publicScans })),

    http.get("/api/panel/repo/:owner/:name", ({ params }) =>
      HttpResponse.json(resolveDetail(String(params.owner), String(params.name))),
    ),
  ];
}

/** Register the happy-path set as the default for a test. */
export function useHappyPanel(data: PanelData = {}): void {
  server.use(...panelHandlers(data));
}
