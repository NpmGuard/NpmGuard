/**
 * Unit: the typed engine routes — api.ts (over api-base.ts).
 *
 * Input classes (per route: the two branches of the HTTP boundary):
 *  C1  happy path            — a 2xx JSON body is returned typed and unwrapped.
 *  C2  error → ApiError      — a non-2xx response throws ApiError{status, body};
 *                              callers branch on `status`, never on message text.
 *  C3  status branching      — distinct engine statuses (402/404/501) arrive intact
 *                              on ApiError.status so the UI can dispatch on them.
 *  C4  raw-text file route   — fetchAuditFile returns text on 200, throws on non-ok.
 *
 * Blackbox via msw: ORIGIN-RELATIVE handlers (http.get("/api/…")) matched against
 * the jsdom origin; apiBase() is pinned to `${origin}/api` so undici sees an
 * absolute URL while the handlers stay origin-relative.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { ApiError } from "./api-base.ts";
import {
  fetchAuditFile,
  fetchAuditReport,
  fetchCheckoutStatus,
  fetchDemoPackages,
  fetchPackageReport,
  fetchPackages,
  fetchPublicConfig,
  resolveVersion,
  startAuditStream,
  startCheckout,
  startDemo,
} from "./api.ts";
import type { AuditReport } from "./engine-types.ts";

const server = setupServer();

beforeAll(() => {
  // Absolute base against the jsdom origin: undici needs an absolute URL, while
  // the msw handlers below stay origin-relative.
  window.__NPMGUARD_CONFIG__ = { apiBase: `${window.location.origin}/api` };
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  delete window.__NPMGUARD_CONFIG__;
});

const report: AuditReport = {
  schemaVersion: 2,
  verdict: "SAFE",
  rationale: "clean",
  counts: { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 },
  confirmedHypIds: [],
  hypotheses: [],
  fileSummaries: [],
  dealbreaker: null,
  trace: [],
};

describe("api — C1 happy paths", () => {
  it("C1: fetchPublicConfig returns the parsed PublicConfig", async () => {
    server.use(
      http.get("/api/config/public", () =>
        HttpResponse.json({ paymentRequired: false, paymentEnabled: false, stripeEnabled: true, priceCents: 500, crypto: null }),
      ),
    );
    const cfg = await fetchPublicConfig();
    expect(cfg.priceCents).toBe(500);
    expect(cfg.stripeEnabled).toBe(true);
  });

  it("C1: resolveVersion resolves a dist-tag to a concrete version (scoped names keep the slash)", async () => {
    let seenPath = "";
    server.use(
      http.get("/api/resolve/*", ({ request }) => {
        seenPath = new URL(request.url).pathname;
        return HttpResponse.json({ packageName: "@scope/pkg", version: "2.3.4" });
      }),
    );
    const res = await resolveVersion("@scope/pkg", "latest");
    expect(res.version).toBe("2.3.4");
    expect(seenPath).toBe("/api/resolve/@scope/pkg"); // slash NOT encoded
  });

  it("C1: startAuditStream posts the payload and returns the auditId", async () => {
    server.use(
      http.post("/api/audit/stream", async ({ request }) => {
        const body = (await request.json()) as { packageName: string };
        return HttpResponse.json({ auditId: "aud-1", packageName: body.packageName });
      }),
    );
    const res = await startAuditStream({ packageName: "chalk", version: "5.0.0" });
    expect(res).toEqual({ auditId: "aud-1", packageName: "chalk" });
  });

  it("C1: startDemo returns the demo session id", async () => {
    server.use(http.post("/api/demo/start", () => HttpResponse.json({ auditId: "demo-1", packageName: "test-pkg-env-exfil" })));
    const res = await startDemo("test-pkg-env-exfil");
    expect(res.auditId).toBe("demo-1");
  });

  it("C1: fetchDemoPackages returns the (possibly empty) list", async () => {
    server.use(http.get("/api/demo/packages", () => HttpResponse.json({ packages: [] })));
    expect(await fetchDemoPackages()).toEqual({ packages: [] });
  });

  it("C1: startCheckout returns the Stripe url + sessionId", async () => {
    server.use(http.post("/api/checkout", () => HttpResponse.json({ url: "https://stripe.test/s", sessionId: "cs_1" })));
    const res = await startCheckout("chalk", "5.0.0", "a@b.co");
    expect(res.url).toContain("stripe");
  });

  it("C1: fetchCheckoutStatus reports the claimed auditId", async () => {
    server.use(
      http.get("/api/checkout/:id/status", () =>
        HttpResponse.json({ paid: true, packageName: "chalk", version: "5.0.0", auditId: "aud-9" }),
      ),
    );
    const res = await fetchCheckoutStatus("cs_1");
    expect(res.paid).toBe(true);
    expect(res.auditId).toBe("aud-9");
  });

  it("C1: fetchAuditReport returns the bare schemaVersion-2 report", async () => {
    server.use(http.get("/api/audit/:id/report", () => HttpResponse.json(report)));
    const res = await fetchAuditReport("aud-1");
    expect(res.schemaVersion).toBe(2);
    expect(res.verdict).toBe("SAFE");
  });

  it("C1: fetchPackages returns the report index", async () => {
    server.use(
      http.get("/api/packages", () =>
        HttpResponse.json({ packages: [{ packageName: "chalk", version: "5.0.0", verdict: "SAFE", auditedAt: "2026-07-01T00:00:00Z" }] }),
      ),
    );
    const res = await fetchPackages();
    expect(res.packages).toHaveLength(1);
  });

  it("C1: fetchPackageReport unwraps the {report,version,packageName} envelope", async () => {
    server.use(http.get("/api/package/*/report", () => HttpResponse.json({ report, version: "5.0.0", packageName: "chalk" })));
    const res = await fetchPackageReport("chalk", "5.0.0");
    expect(res.packageName).toBe("chalk");
    expect(res.report.schemaVersion).toBe(2);
  });
});

describe("api — C2/C3 error → ApiError, status branching", () => {
  it("C3: a 402 payment-required surfaces as ApiError{status:402, body}", async () => {
    server.use(
      http.post("/api/audit/stream", () =>
        HttpResponse.json({ error: "Payment required. Use /checkout or provide txHash + chain." }, { status: 402 }),
      ),
    );
    await expect(startAuditStream({ packageName: "chalk", version: "5.0.0" })).rejects.toMatchObject({
      status: 402,
    });
    // and the parsed body is attached for the caller
    const err = await startAuditStream({ packageName: "chalk", version: "5.0.0" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body).toMatchObject({ error: expect.stringContaining("Payment required") });
  });

  it("C3: a 404 report-not-found surfaces status 404", async () => {
    server.use(http.get("/api/package/*/report", () => HttpResponse.json({ error: "No audit report found for ghost" }, { status: 404 })));
    const err = await fetchPackageReport("ghost").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("C3: a 501 stripe-not-configured surfaces status 501", async () => {
    server.use(http.post("/api/checkout", () => HttpResponse.json({ error: "Stripe payments not configured" }, { status: 501 })));
    const err = await startCheckout("chalk").catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(501);
  });

  it("C2: a non-JSON error body still throws ApiError with the raw text as body", async () => {
    server.use(http.get("/api/config/public", () => new HttpResponse("upstream exploded", { status: 500 })));
    const err = await fetchPublicConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).body).toBe("upstream exploded");
  });
});

describe("api — C4 raw-text file route", () => {
  it("C4: fetchAuditFile returns the file text on 200", async () => {
    server.use(http.get("/api/audit/:id/file/*", () => new HttpResponse("const x = 1;\n", { status: 200 })));
    const text = await fetchAuditFile("aud-1", "index.js");
    expect(text).toBe("const x = 1;\n");
  });

  it("C4: fetchAuditFile throws a plain Error on a non-ok response", async () => {
    server.use(http.get("/api/audit/:id/file/*", () => new HttpResponse("nope", { status: 404 })));
    await expect(fetchAuditFile("aud-1", "missing.js")).rejects.toThrow(/404/);
  });
});
