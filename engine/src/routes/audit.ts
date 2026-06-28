import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  ChainVerificationError,
  isChainConfigured,
  verifyAuditPayment,
  type SupportedChain,
} from "../chain.js";
import { getChainPayment, recordChainPayment } from "../chain-payment-map.js";
import { config, PAYMENT_ENABLED } from "../config.js";
import { NpmGuardError, QueueFullError } from "../errors.js";
import {
  createEmitFn,
  createSession,
  finalizeSession,
  getSession,
  type AuditEvent,
} from "../events.js";
import { getPayment, recordPayment } from "../payment-map.js";
import { runAudit } from "../pipeline.js";
import { saveReport } from "../report-store.js";
import { verifyCheckoutSession } from "../stripe.js";
import type { AuditReport } from "../models.js";
import { AuditRequest, StreamAuditRequest } from "./validation.js";

// ---------------------------------------------------------------------------
// Audit queue — one audit at a time, prevents rate limiting & resource
// exhaustion. Only consumed by POST /audit (CRE sync path). /audit/stream
// runs audits directly without queuing.
// ---------------------------------------------------------------------------

type QueueItem = {
  packageName: string;
  version?: string;
  resolve: (v: AuditReport) => void;
  reject: (e: unknown) => void;
};

const auditQueue: QueueItem[] = [];
let auditRunning = false;
const MAX_QUEUE_SIZE = 50;

async function processQueue(): Promise<void> {
  if (auditRunning || auditQueue.length === 0) return;
  auditRunning = true;
  const item = auditQueue.shift()!;
  console.log(`[queue] starting ${item.packageName} (${auditQueue.length} queued)`);

  try {
    const { report, cleanup } = await runAudit(item.packageName, undefined, undefined, item.version);
    saveReport(item.packageName, item.version || "latest", report);
    cleanup();
    item.resolve(report);
  } catch (err) {
    item.reject(err);
  } finally {
    auditRunning = false;
    processQueue();
  }
}

function enqueueAudit(packageName: string, version?: string): Promise<AuditReport> {
  if (auditQueue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new QueueFullError());
  }
  return new Promise((resolve, reject) => {
    auditQueue.push({ packageName, version, resolve, reject });
    processQueue();
  });
}

export const auditRoutes = new Hono();

// ---------------------------------------------------------------------------
// POST /audit — sync for CLI, fire-and-forget for CRE
// ---------------------------------------------------------------------------

auditRoutes.post("/audit", async (c) => {
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
    return c.json(
      { error: "Use /checkout for paid audits, or /audit/stream with stripeSessionId" },
      402,
    );
  }

  // CRE: fire-and-forget — return 202 immediately, audit queued in background
  if (isCre) {
    enqueueAudit(parsed.data.packageName, parsed.data.version)
      .then((report) =>
        console.log(`[queue] completed ${parsed.data.packageName}: ${report.verdict}`),
      )
      .catch((err) =>
        console.error(
          `[queue] failed ${parsed.data.packageName}:`,
          err instanceof Error ? err.message : err,
        ),
      );

    return c.json(
      {
        status: "accepted",
        packageName: parsed.data.packageName,
        version: parsed.data.version,
        queuePosition: auditQueue.length,
      },
      202,
    );
  }

  // CLI/direct: wait for result (also queued, so only one runs at a time)
  try {
    const report = await enqueueAudit(parsed.data.packageName, parsed.data.version);
    return c.json(report);
  } catch (err) {
    console.error("[api] audit failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    const statusCode = err instanceof NpmGuardError ? err.statusCode : 500;
    return c.json(
      {
        error: "Audit failed",
        message,
        code: err instanceof NpmGuardError ? err.code : "NPMGUARD-9999",
        retryable: err instanceof NpmGuardError ? err.retryable : false,
      },
      statusCode as 400 | 404 | 500 | 503 | 504,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /audit/stream — payment gate + async audit, client subscribes via SSE.
//
// The payment gate is a three-branch trust contract. It is deliberately
// inline (not extracted to a helper) so a reader can see, in one place,
// exactly what conditions lead to createSession() being called:
//
//   1. txHash + chain  → on-chain Base Sepolia / mainnet verify + dedup
//   2. stripeSessionId → Stripe verify (with double-check race protection)
//   3. (neither)       → dev mode, only if PAYMENT_ENABLED=false
// ---------------------------------------------------------------------------

auditRoutes.post("/audit/stream", async (c) => {
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
  let chainRequester: string | undefined;
  let resolvedChain: SupportedChain | undefined;

  if (parsed.data.txHash) {
    // On-chain payment verification (Base Sepolia / Base mainnet)
    const chain: SupportedChain = parsed.data.chain ?? "base-sepolia";
    resolvedChain = chain;
    if (!isChainConfigured(chain)) {
      return c.json({ error: `Chain ${chain} is not configured on this engine` }, 501);
    }
    if (!parsed.data.packageName || !parsed.data.version) {
      return c.json(
        { error: "packageName and version are required with txHash" },
        400,
      );
    }

    // Dedup — one txHash can only ever trigger one audit
    const existing = getChainPayment(chain, parsed.data.txHash);
    if (existing) {
      return c.json({
        auditId: existing.auditId,
        packageName: existing.packageName,
      });
    }

    try {
      const verified = await verifyAuditPayment(
        chain,
        parsed.data.txHash as `0x${string}`,
        parsed.data.packageName,
        parsed.data.version,
      );
      packageName = verified.packageName;
      version = verified.version;
      chainRequester = verified.requester;
      console.log(
        `[chain] verified ${chain} tx ${parsed.data.txHash} from ${verified.requester} for ${packageName}@${version}`,
      );
    } catch (err) {
      if (err instanceof ChainVerificationError) {
        console.warn(`[chain] verification failed: ${err.message}`);
        return c.json({ error: err.message }, 402);
      }
      console.error("[chain] unexpected error:", err);
      return c.json({ error: "Chain verification failed" }, 500);
    }

    // Double-check: a concurrent identical-txHash request may have started the
    // audit during our async receipt poll. Re-read the dedup map before
    // launching a second audit for the same payment.
    const claimedDuringVerify = getChainPayment(chain, parsed.data.txHash);
    if (claimedDuringVerify) {
      return c.json({
        auditId: claimedDuringVerify.auditId,
        packageName: claimedDuringVerify.packageName,
      });
    }
  } else if (parsed.data.stripeSessionId) {
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
      return c.json({
        auditId: claimedDuringVerify.auditId,
        packageName: claimedDuringVerify.packageName,
      });
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
    recordPayment(
      parsed.data.stripeSessionId,
      session.auditId,
      packageName,
      version || "latest",
    );
  }

  // Record on-chain payment for dedup (txHash + chain).
  // Must use the resolved chain (with default applied), not the raw input —
  // otherwise a client omitting `chain` would bypass dedup and replay the tx.
  if (parsed.data.txHash && resolvedChain) {
    recordChainPayment(resolvedChain, parsed.data.txHash, {
      auditId: session.auditId,
      packageName,
      version: version ?? "latest",
      requester: chainRequester ?? "",
    });
  }

  // Run audit in background — don't await
  runAudit(packageName, emit, session.auditId, version)
    .then(({ report, cleanup }) => {
      finalizeSession(session.auditId, report);
      saveReport(packageName, version || "latest", report);
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

// ---------------------------------------------------------------------------
// SSE event stream for a running (or finalized) audit — replays the buffered
// events, then streams live until verdict_reached or audit_error.
// ---------------------------------------------------------------------------

auditRoutes.get("/audit/:id/events", (c) => {
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

// ---------------------------------------------------------------------------
// Serve raw file content from a running audit's package directory.
// Path traversal check: resolve to absolute and require it stays under the
// session's packagePath prefix.
// ---------------------------------------------------------------------------

auditRoutes.get("/audit/:id/file/*", (c) => {
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

// ---------------------------------------------------------------------------
// Get final report for a completed audit
// ---------------------------------------------------------------------------

auditRoutes.get("/audit/:id/report", (c) => {
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
