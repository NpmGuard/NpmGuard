import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";

import { config, PAYMENT_ENABLED } from "./config.js";
import { runAudit, type AuditResult } from "./pipeline.js";
import type { AuditReport } from "./models.js";
import { createSession, getSession, finalizeSession, createEmitFn, type AuditEvent } from "./events.js";
import { cleanupPackage } from "./phases/resolve.js";
import { createCheckoutSession, verifyCheckoutSession, constructWebhookEvent } from "./stripe.js";
import { recordPayment, getPayment, cleanupOldPayments } from "./payment-map.js";
import { NpmGuardError, QueueFullError } from "./errors.js";
import { getAvailableDemos, startReplay } from "./demo.js";

const app = new Hono();

// Enable CORS for frontend dev server
app.use("/*", cors({
  origin: process.env.NPMGUARD_CORS_ORIGIN ?? "http://localhost:5173",
  credentials: true,
}));

const PackageName = z
  .string()
  .min(1)
  .max(214)
  .regex(
    /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    "Invalid npm package name",
  );

const SemverVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/, "Invalid semver version");

const AuditRequest = z.object({
  packageName: PackageName,
  version: SemverVersion.optional(),
});

// ---------------------------------------------------------------------------
// Audit queue — one audit at a time, prevents rate limiting & resource exhaustion
// ---------------------------------------------------------------------------

type QueueItem = { packageName: string; version?: string; resolve: (v: AuditReport) => void; reject: (e: unknown) => void };
const auditQueue: QueueItem[] = [];
let auditRunning = false;

async function processQueue() {
  if (auditRunning || auditQueue.length === 0) return;
  auditRunning = true;
  const item = auditQueue.shift()!;
  console.log(`[queue] starting ${item.packageName} (${auditQueue.length} queued)`);

  try {
    const { report, cleanup } = await runAudit(item.packageName, undefined, undefined, item.version);
    cleanup();
    item.resolve(report);
  } catch (err) {
    item.reject(err);
  } finally {
    auditRunning = false;
    processQueue();
  }
}

const MAX_QUEUE_SIZE = 50;

function enqueueAudit(packageName: string, version?: string): Promise<AuditReport> {
  if (auditQueue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new QueueFullError());
  }
  return new Promise((resolve, reject) => {
    auditQueue.push({ packageName, version, resolve, reject });
    processQueue();
  });
}

// ---------------------------------------------------------------------------
// Stripe checkout & webhooks
// ---------------------------------------------------------------------------

const CheckoutRequest = z.object({
  packageName: PackageName,
  version: SemverVersion.optional(),
  email: z.string().email().optional(),
});

app.post("/checkout", async (c) => {
  if (!PAYMENT_ENABLED) {
    return c.json({ error: "Payments not configured" }, 501);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = CheckoutRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.format() }, 400);
  }

  const version = parsed.data.version || "latest";
  const origin = c.req.header("Origin")
    || c.req.header("Referer")?.replace(/\/+$/, "")
    || `http://localhost:${config.apiPort}`;

  try {
    const { url } = await createCheckoutSession({
      packageName: parsed.data.packageName,
      version,
      email: parsed.data.email,
      origin,
    });
    return c.json({ url });
  } catch (err) {
    console.error("[checkout] Stripe session creation failed:", err);
    return c.json({ error: "Payment system error" }, 500);
  }
});

app.post("/webhooks/stripe", async (c) => {
  if (!PAYMENT_ENABLED || !config.stripeWebhookSecret) {
    return c.json({ error: "Webhook not configured" }, 501);
  }

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 400);
  }

  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.json({ error: "Cannot read body" }, 400);
  }

  let event: import("stripe").Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    console.warn("[webhook] signature verification failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const stripeSession = event.data.object;
      const { packageName, version } = stripeSession.metadata || {};
      console.log(`[webhook] checkout.session.completed: ${stripeSession.id} for ${packageName}@${version}`);

      if (!packageName) {
        console.warn(`[webhook] checkout.session.completed missing metadata: ${stripeSession.id}`);
        break;
      }

      const existing = getPayment(stripeSession.id);
      if (existing) {
        console.log(`[webhook] audit already started: ${existing.auditId}`);
        break;
      }

      // Client hasn't returned yet — start the audit from the webhook
      console.log(`[webhook] starting audit for ${packageName}@${version} (session ${stripeSession.id})`);
      try {
        const auditSession = createSession(packageName);
        const emit = createEmitFn(auditSession.auditId, auditSession.emitter);
        recordPayment(stripeSession.id, auditSession.auditId, packageName, version || "latest");

        runAudit(packageName, emit, auditSession.auditId, version || undefined)
          .then(({ report, cleanup }) => {
            finalizeSession(auditSession.auditId, report);
            cleanup();
          })
          .catch((err) => {
            console.error(`[webhook] audit failed for ${packageName}:`, err);
            const message = err instanceof Error ? err.message : "Unknown error";
            const code = err instanceof NpmGuardError ? err.code : "NPMGUARD-9999";
            emit("audit_error", { error: message, code, retryable: false });
            finalizeSession(auditSession.auditId, null, message);
          });
      } catch (err) {
        console.error(`[webhook] failed to start audit for ${packageName}:`, err);
        // Return 500 so Stripe retries the webhook later
        return c.json({ error: "Failed to start audit" }, 500);
      }
      break;
    }
    default:
      console.log(`[webhook] unhandled event type: ${event.type}`);
  }

  return c.json({ received: true });
});

app.get("/config/public", (c) =>
  c.json({
    paymentEnabled: PAYMENT_ENABLED,
    priceCents: config.auditPriceCents,
  }),
);

// ---------------------------------------------------------------------------
// Demo replay endpoints
// ---------------------------------------------------------------------------

app.get("/demo/packages", (c) => c.json({ packages: getAvailableDemos() }));

app.post("/demo/start", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { packageName } = body as { packageName?: string };
  if (!packageName) {
    return c.json({ error: "packageName is required" }, 400);
  }

  try {
    const result = startReplay(packageName);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 404);
  }
});

// ---------------------------------------------------------------------------
// POST /audit — sync for CLI, fire-and-forget for CRE
// ---------------------------------------------------------------------------

app.post("/audit", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = AuditRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.format() }, 400);
  }

  const apiKey = c.req.header("X-API-Key");
  const isCre = !!(config.creApiKey && apiKey === config.creApiKey);

  if (isCre) {
    console.log(`[auth] CRE authenticated for ${parsed.data.packageName}`);
  } else if (PAYMENT_ENABLED) {
    return c.json({ error: "Use /checkout for paid audits, or /audit/stream with stripeSessionId" }, 402);
  }

  // CRE: fire-and-forget — return 202 immediately, audit queued in background
  if (isCre) {
    enqueueAudit(parsed.data.packageName, parsed.data.version)
      .then((report) => console.log(`[queue] completed ${parsed.data.packageName}: ${report.verdict}`))
      .catch((err) => console.error(`[queue] failed ${parsed.data.packageName}:`, err instanceof Error ? err.message : err));

    return c.json({
      status: "accepted",
      packageName: parsed.data.packageName,
      version: parsed.data.version,
      queuePosition: auditQueue.length,
    }, 202);
  }

  // CLI/direct: wait for result (also queued, so only one runs at a time)
  try {
    const report = await enqueueAudit(parsed.data.packageName, parsed.data.version);
    return c.json(report);
  } catch (err) {
    console.error("[api] audit failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    const statusCode = err instanceof NpmGuardError ? err.statusCode : 500;
    return c.json({
      error: "Audit failed",
      message,
      code: err instanceof NpmGuardError ? err.code : "NPMGUARD-9999",
      retryable: err instanceof NpmGuardError ? err.retryable : false,
    }, statusCode as 400 | 404 | 500 | 503 | 504);
  }
});

// ---------------------------------------------------------------------------
// Streaming audit endpoints
// ---------------------------------------------------------------------------

// Start audit asynchronously, returns auditId for SSE streaming
const StreamAuditRequest = z.object({
  packageName: PackageName.optional(),
  version: SemverVersion.optional(),
  stripeSessionId: z.string().optional(),
});

app.post("/audit/stream", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = StreamAuditRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.format() }, 400);
  }

  // --- Payment gate ---
  let packageName: string;
  let version: string | undefined;

  if (parsed.data.stripeSessionId) {
    if (!PAYMENT_ENABLED) {
      return c.json({ error: "Payments not configured" }, 501);
    }

    // Dedup: return existing auditId if this session was already verified
    const existing = getPayment(parsed.data.stripeSessionId);
    if (existing) {
      return c.json({ auditId: existing.auditId, packageName: existing.packageName });
    }

    try {
      const verification = await verifyCheckoutSession(parsed.data.stripeSessionId);
      if (!verification.paid) {
        return c.json({ error: "Payment not completed" }, 402);
      }
      packageName = verification.packageName;
      version = verification.version;
    } catch (err) {
      console.error("[payment] Stripe verification failed:", err);
      return c.json({ error: "Payment verification failed" }, 402);
    }

    // Double-check: webhook may have started the audit during our async Stripe call
    const claimedDuringVerify = getPayment(parsed.data.stripeSessionId);
    if (claimedDuringVerify) {
      return c.json({ auditId: claimedDuringVerify.auditId, packageName: claimedDuringVerify.packageName });
    }
  } else if (!PAYMENT_ENABLED) {
    // Dev mode: no payment required
    if (!parsed.data.packageName) {
      return c.json({ error: "packageName is required" }, 400);
    }
    packageName = parsed.data.packageName;
    version = parsed.data.version;
  } else {
    // Payment enabled but no stripeSessionId
    return c.json({ error: "Payment required. Use /checkout first." }, 402);
  }

  // --- Start audit ---
  const session = createSession(packageName);
  const emit = createEmitFn(session.auditId, session.emitter);

  // Record payment for dedup (if Stripe-paid)
  if (parsed.data.stripeSessionId) {
    recordPayment(parsed.data.stripeSessionId, session.auditId, packageName, version || "latest");
  }

  // Run audit in background — don't await
  runAudit(packageName, emit, session.auditId, version)
    .then(({ report, cleanup }) => {
      finalizeSession(session.auditId, report);
      cleanup();
    })
    .catch((err) => {
      console.error("[api] streaming audit failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      const code = err instanceof NpmGuardError ? err.code : "NPMGUARD-9999";
      const retryable = err instanceof NpmGuardError ? err.retryable : false;
      emit("audit_error", { error: message, code, retryable });
      finalizeSession(session.auditId, null, message);
    });

  return c.json({ auditId: session.auditId, packageName });
});

// SSE event stream for a running audit
app.get("/audit/:id/events", (c) => {
  const auditId = c.req.param("id");
  const session = getSession(auditId);
  if (!session) {
    return c.json({ error: "Audit session not found" }, 404);
  }

  // Disable nginx proxy buffering so SSE events stream immediately
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    let eventId = 0;

    // Replay all buffered events so late-connecting clients catch up
    for (const event of session.eventBuffer) {
      try {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          id: String(eventId++),
        });
      } catch {
        console.warn(`[sse] replay write failed for ${auditId}, client likely disconnected`);
        break;
      }
    }

    // If audit already finished, we're done after replay
    if (session.status !== "running") {
      return;
    }

    const handler = async (event: AuditEvent) => {
      try {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          id: String(eventId++),
        });
      } catch {
        console.warn(`[sse] live write failed for ${auditId}, client likely disconnected`);
      }
    };

    session.emitter.on("event", handler);

    // Wait until audit completes or client disconnects
    await new Promise<void>((resolve) => {
      const done = () => {
        session.emitter.off("event", handler);
        resolve();
      };

      // Listen for terminal events
      const terminalHandler = (event: AuditEvent) => {
        if (event.type === "verdict_reached" || event.type === "audit_error") {
          // Give a moment for the event to be sent
          setTimeout(done, 100);
        }
      };
      session.emitter.on("event", terminalHandler);

      stream.onAbort(() => {
        session.emitter.off("event", terminalHandler);
        done();
      });
    });
  });
});

// Serve raw file content from a running audit's package
app.get("/audit/:id/file/*", (c) => {
  const auditId = c.req.param("id");
  const session = getSession(auditId);
  if (!session) {
    return c.json({ error: "Audit session not found" }, 404);
  }
  if (!session.packagePath) {
    return c.json({ error: "Package not yet resolved" }, 404);
  }

  const filePath = c.req.path.replace(`/audit/${auditId}/file/`, "");

  // Demo replay: serve from in-memory file contents
  if (session.fileContents) {
    const content = session.fileContents[filePath];
    if (content !== undefined) return c.text(content);
    return c.json({ error: "File not found" }, 404);
  }

  const absPath = path.join(session.packagePath, filePath);

  // Security: ensure path stays within package directory
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(path.resolve(session.packagePath))) {
    return c.json({ error: "Path traversal denied" }, 403);
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    return c.text(content);
  } catch {
    return c.json({ error: "File not found" }, 404);
  }
});

// Get final report for a completed audit
app.get("/audit/:id/report", (c) => {
  const auditId = c.req.param("id");
  const session = getSession(auditId);
  if (!session) {
    return c.json({ error: "Audit session not found" }, 404);
  }
  if (session.status === "running") {
    return c.json({ status: "running" }, 202);
  }
  if (session.report) {
    return c.json(session.report);
  }
  return c.json({ error: "Audit failed" }, 500);
});

app.get("/health", (c) => c.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// /api/* mirror — so frontend can use /api prefix in both dev and production
// ---------------------------------------------------------------------------
app.all("/api/*", async (c) => {
  const newPath = c.req.path.replace(/^\/api/, "") || "/";
  const url = new URL(c.req.url);
  url.pathname = newPath;
  const newReq = new Request(url.toString(), c.req.raw);
  return app.fetch(newReq, c.env);
});

// ---------------------------------------------------------------------------
// Static file serving — frontend dist (production)
// ---------------------------------------------------------------------------
const frontendDist = path.resolve(import.meta.dirname, "../../frontend/dist");

if (fs.existsSync(frontendDist)) {
  console.log(`[static] Serving frontend from ${frontendDist}`);

  app.use(
    "/*",
    serveStatic({
      root: path.relative(process.cwd(), frontendDist),
    }),
  );

  // SPA fallback — serve index.html for non-API, non-file routes
  app.get("/*", (c) => {
    const indexPath = path.join(frontendDist, "index.html");
    const html = fs.readFileSync(indexPath, "utf-8");
    return c.html(html);
  });
} else {
  console.log(`[static] No frontend build found at ${frontendDist} — API-only mode`);
}

// Periodic cleanup of expired payment records
setInterval(cleanupOldPayments, 10 * 60_000);

console.log(`NpmGuard Engine starting on ${config.apiHost}:${config.apiPort}`);
serve({ fetch: app.fetch, hostname: config.apiHost, port: config.apiPort });
