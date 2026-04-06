import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";

import { config, PAYMENT_ENABLED } from "./config.js";
import { runAudit } from "./pipeline.js";
import { createSession, getSession, finalizeSession, createEmitFn, type AuditEvent } from "./events.js";
import { cleanupPackage } from "./phases/resolve.js";
import { createCheckoutSession, verifyCheckoutSession, constructWebhookEvent } from "./stripe.js";
import { recordPayment, getPayment, cleanupOldPayments } from "./payment-map.js";

const app = new Hono();

// Enable CORS for frontend dev server
app.use("/*", cors({
  origin: process.env.NPMGUARD_CORS_ORIGIN ?? "http://localhost:5173",
  credentials: true,
}));

const AuditRequest = z.object({
  packageName: z.string().min(1),
  version: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Audit queue — one audit at a time, prevents rate limiting & resource exhaustion
// ---------------------------------------------------------------------------

type QueueItem = { packageName: string; version?: string; resolve: (v: any) => void; reject: (e: any) => void };
const auditQueue: QueueItem[] = [];
let auditRunning = false;

async function processQueue() {
  if (auditRunning || auditQueue.length === 0) return;
  auditRunning = true;
  const item = auditQueue.shift()!;
  console.log(`[queue] starting ${item.packageName} (${auditQueue.length} queued)`);

  try {
    const { report, cleanup } = await runAudit(item.packageName);
    cleanup();
    item.resolve(report);
  } catch (err) {
    item.reject(err);
  } finally {
    auditRunning = false;
    processQueue();
  }
}

function enqueueAudit(packageName: string, version?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    auditQueue.push({ packageName, version, resolve, reject });
    processQueue();
  });
}

// ---------------------------------------------------------------------------
// Stripe checkout & webhooks
// ---------------------------------------------------------------------------

const CheckoutRequest = z.object({
  packageName: z.string().min(1),
  version: z.string().optional(),
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
      const session = event.data.object;
      const { packageName, version } = session.metadata || {};
      console.log(`[webhook] checkout.session.completed: ${session.id} for ${packageName}@${version}`);

      const existing = getPayment(session.id);
      if (existing) {
        console.log(`[webhook] audit already started: ${existing.auditId}`);
      } else {
        console.warn(`[webhook] payment received but audit not started (user may not have returned): ${session.id}`);
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
    return c.json({ error: "Audit failed", message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Streaming audit endpoints
// ---------------------------------------------------------------------------

// Start audit asynchronously, returns auditId for SSE streaming
const StreamAuditRequest = z.object({
  packageName: z.string().min(1).optional(),
  version: z.string().optional(),
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
  runAudit(packageName, emit, session.auditId)
    .then(({ report, cleanup }) => {
      finalizeSession(session.auditId, report);
      cleanup();
    })
    .catch((err) => {
      console.error("[api] streaming audit failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      emit("audit_error", { error: message });
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
      } catch { break; }
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
        // Client disconnected
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
