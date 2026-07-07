import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as fs from "node:fs";
import * as path from "node:path";

import { cleanupOldChainPayments } from "./chain-payment-map.js";
import { config, GITHUB_APP_ENABLED } from "./config.js";
import { startReconcile } from "./jobs/reconcile.js";
import { resetStaleRunningJobs } from "./jobs/queue.js";
import { startWorkers } from "./jobs/workers.js";
import { cleanupOldPayments } from "./payment-map.js";
import { authRoutes } from "./routes/auth.js";
import { auditRoutes } from "./routes/audit.js";
import { benchRoutes } from "./routes/bench.js";
import { demoRoutes } from "./routes/demo.js";
import { ghWebhookRoutes } from "./routes/gh-webhooks.js";
import { panelRoutes } from "./routes/panel.js";
import { paymentRoutes } from "./routes/payment.js";
import { registryRoutes } from "./routes/registry.js";
import { cleanupExpiredSessions } from "./session.js";
import { installReportHook, rebuildVerdictIndex } from "./verdict-index.js";
import { startRegistryWatch } from "./watch/poller.js";

const app = new Hono();

// Enable CORS for frontend dev server
app.use("/*", cors({
  origin: process.env.NPMGUARD_CORS_ORIGIN ?? "http://localhost:5173",
  credentials: true,
}));

// Subrouters are all mounted on the same app namespace via app.route("/", ...).
// This keeps the /api/* rewrite below working (app.fetch re-enters the full
// routing tree) and preserves SSE streaming through Hono's streamSSE.
app.route("/", auditRoutes);
app.route("/", paymentRoutes);
app.route("/", demoRoutes);
app.route("/", registryRoutes);
app.route("/", benchRoutes);
app.route("/", authRoutes);
app.route("/", panelRoutes);
app.route("/", ghWebhookRoutes);

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
setInterval(cleanupOldChainPayments, 10 * 60_000);

// Panel machinery (spec §8): verdict index, durable job workers, registry
// watch, daily reconcile. All gated on the GitHub App being configured.
if (GITHUB_APP_ENABLED) {
  installReportHook();
  rebuildVerdictIndex();
  resetStaleRunningJobs();
  startWorkers();
  startRegistryWatch();
  startReconcile();
  setInterval(cleanupExpiredSessions, 60 * 60_000);
}

console.log(`NpmGuard Engine starting on ${config.apiHost}:${config.apiPort}`);
serve({ fetch: app.fetch, hostname: config.apiHost, port: config.apiPort });
