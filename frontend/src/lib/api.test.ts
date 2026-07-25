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
 *  C5  contract violation    — the report routes PARSE their response against
 *                              AuditReportSchema, so drift throws
 *                              ContractViolationError (never ApiError: the request
 *                              succeeded, so a status branch would call it healthy)
 *                              instead of reaching a component as `undefined`.
 *  C6  envelopes too         — the same holds for the routes' HTTP ENVELOPES, which
 *                              were the last cast shapes in the app. Each case is a
 *                              field a real consumer dereferences unchecked.
 *
 * Blackbox via msw: ORIGIN-RELATIVE handlers (http.get("/api/…")) matched against
 * the jsdom origin; apiBase() is pinned to `${origin}/api` so undici sees an
 * absolute URL while the handlers stay origin-relative.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { ApiError } from "./api-base.ts";
import { ContractViolationError } from "./wire.ts";
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
import type { AuditReport } from "@npmguard/shared";

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

describe("api — C5 report responses are CHECKED, not cast", () => {
  /**
   * The report routes used to be `getJson<AuditReport>` — a cast that promised a
   * report and delivered whatever the engine sent. These assert the two halves of
   * the replacement: drift throws, and it throws something the retry policy will
   * not loop on.
   */
  it("C5: fetchAuditReport rejects a report that violates AuditReportSchema", async () => {
    // An out-of-domain verdict is the sharpest case: SUSPECT is not in the domain,
    // and the old cast would have handed it to a tone lookup that has no arm for it.
    server.use(
      http.get("/api/audit/:id/report", () => HttpResponse.json({ ...report, verdict: "SUSPECT" })),
    );
    const err = await fetchAuditReport("aud-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractViolationError);
    expect((err as ContractViolationError).what).toContain("/audit/aud-1/report");
  });

  it("C5: a dropped report field fails loud rather than reaching a component as undefined", async () => {
    const { counts: _dropped, ...withoutCounts } = report;
    server.use(http.get("/api/audit/:id/report", () => HttpResponse.json(withoutCounts)));
    const err = await fetchAuditReport("aud-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractViolationError);
    // the message names the field, so a support conversation can start from it
    expect((err as Error).message).toContain("counts");
  });

  it("C5: a contract violation is NOT an ApiError — a 200 must not read as a healthy report", async () => {
    // The request succeeded, so `status` would be 200 and every status-based branch
    // would treat this as fine. That is why drift has its own error type.
    server.use(http.get("/api/audit/:id/report", () => HttpResponse.json({ nonsense: true })));
    const err = await fetchAuditReport("aud-1").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(ContractViolationError);
  });

  it("C5: a 202 still-running body no longer passes as a finished report", async () => {
    // The engine answers 202 {status} while the audit runs. Under the old cast this
    // became `report = {status:"running"}` — a live object in the report view with
    // no verdict, no counts and no complaint.
    server.use(
      http.get("/api/audit/:id/report", () => HttpResponse.json({ status: "running" }, { status: 202 })),
    );
    await expect(fetchAuditReport("aud-1")).rejects.toBeInstanceOf(ContractViolationError);
  });

  it("C5: fetchPackageReport validates the NESTED report, not just the envelope", async () => {
    server.use(
      http.get("/api/package/*/report", () =>
        HttpResponse.json({ report: { ...report, counts: "not-an-object" }, version: "5.0.0", packageName: "chalk" }),
      ),
    );
    await expect(fetchPackageReport("chalk", "5.0.0")).rejects.toBeInstanceOf(ContractViolationError);
  });

  it("C5: fetchPackageReport rejects an envelope missing its label strings", async () => {
    server.use(http.get("/api/package/*/report", () => HttpResponse.json({ report })));
    await expect(fetchPackageReport("chalk")).rejects.toBeInstanceOf(ContractViolationError);
  });

  it("C5: a well-formed report still parses — the checks are not vacuous", async () => {
    // Guards the opposite failure: a schema nothing satisfies would pass every
    // assertion above. The happy paths in C1 cover this too; asserted here so the
    // class stands on its own.
    server.use(http.get("/api/audit/:id/report", () => HttpResponse.json(report)));
    await expect(fetchAuditReport("aud-1")).resolves.toMatchObject({ verdict: "SAFE", schemaVersion: 2 });
  });
});

describe("api — C6 every audit envelope is checked, not just the report", () => {
  /**
   * The envelopes (`{auditId, packageName}`, the public config, the checkout
   * status) were the last shapes with no schema, so `api.ts` cast them: a
   * hand-written interface on this side, a dict literal on the engine's, and
   * nothing that could ever notice the two disagreeing. They are contract shapes
   * now (`shared/src/audit-api.ts`), and these assert the difference that makes.
   *
   * Each case is a field a REAL consumer dereferences without checking, so the
   * counterfactual is concrete rather than decorative — that is the bar for
   * belonging in this class.
   */
  it("C6: a start response missing auditId fails loud, not as a navigation to /audit/undefined", async () => {
    server.use(http.post("/api/audit/stream", () => HttpResponse.json({ packageName: "chalk" })));
    await expect(startAuditStream({ packageName: "chalk", version: "5.0.0" })).rejects.toBeInstanceOf(
      ContractViolationError,
    );
  });

  it("C6: a public config missing priceCents fails loud, not as a NaN price", async () => {
    server.use(
      http.get("/api/config/public", () =>
        HttpResponse.json({ paymentRequired: true, paymentEnabled: true, stripeEnabled: true, crypto: null }),
      ),
    );
    await expect(fetchPublicConfig()).rejects.toBeInstanceOf(ContractViolationError);
  });

  it("C6: a crypto block without a fee is rejected — the engine retracts the method instead", async () => {
    // `auditFeeWei` is non-nullable on purpose: the engine emits `crypto` only
    // when it read the fee, and answers `crypto: null` when it could not. A
    // fee-less block would reach `BigInt(...)` in PayPage's transaction builder.
    server.use(
      http.get("/api/config/public", () =>
        HttpResponse.json({
          paymentRequired: true,
          paymentEnabled: true,
          stripeEnabled: false,
          priceCents: 500,
          crypto: { chain: "base-sepolia", chainId: 84532, contract: "0xabc", auditFeeWei: null },
        }),
      ),
    );
    await expect(fetchPublicConfig()).rejects.toBeInstanceOf(ContractViolationError);
  });

  it("C6: an unclaimed checkout status carries auditId: null, and parses", async () => {
    // Absent-vs-null was the drift: one engine branch sent the key and the other
    // omitted it, so "not claimed yet" and "this engine does not report claims"
    // were the same observation. The contract says null, always present.
    server.use(
      http.get("/api/checkout/:id/status", () =>
        HttpResponse.json({ paid: true, packageName: "chalk", version: "5.0.0", auditId: null }),
      ),
    );
    await expect(fetchCheckoutStatus("cs_1")).resolves.toMatchObject({ paid: true, auditId: null });
  });

  it("C6: a checkout status that OMITS auditId is drift, not an unclaimed payment", async () => {
    server.use(
      http.get("/api/checkout/:id/status", () =>
        HttpResponse.json({ paid: true, packageName: "chalk", version: "5.0.0" }),
      ),
    );
    await expect(fetchCheckoutStatus("cs_1")).rejects.toBeInstanceOf(ContractViolationError);
  });

  it("C6: a package-index row with an out-of-domain verdict is rejected", async () => {
    // The row drives a tone lookup that has no arm for SUSPECT.
    server.use(
      http.get("/api/packages", () =>
        HttpResponse.json({
          packages: [{ packageName: "chalk", version: "5.0.0", verdict: "SUSPECT", auditedAt: "2026-07-01T00:00:00Z" }],
        }),
      ),
    );
    await expect(fetchPackages()).rejects.toBeInstanceOf(ContractViolationError);
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
