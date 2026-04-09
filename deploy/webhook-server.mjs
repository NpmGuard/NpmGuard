// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NpmGuard — GitHub webhook listener
//
// Minimal Node.js HTTP server (zero dependencies) that:
//   1. Listens on localhost:9000
//   2. Validates the GitHub HMAC-SHA256 signature
//   3. Filters for pushes to refs/heads/main
//   4. Spawns deploy/pull-and-restart.sh
//
// Environment:
//   GITHUB_WEBHOOK_SECRET  — shared secret configured in GitHub
//   WEBHOOK_PORT           — listen port (default: 9000)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
if (!SECRET) {
  console.error("GITHUB_WEBHOOK_SECRET is not set. Exiting.");
  process.exit(1);
}

const PORT = parseInt(process.env.WEBHOOK_PORT || "9000", 10);
const DEPLOY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pull-and-restart.sh");

function verifySignature(payload, signature) {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", SECRET).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const server = createServer((req, res) => {
  // Health check
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("webhook ok\n");
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method not allowed\n");
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const signature = req.headers["x-hub-signature-256"];

    if (!verifySignature(body, signature)) {
      console.log(`[${new Date().toISOString()}] Invalid signature — rejected`);
      res.writeHead(401);
      res.end("Invalid signature\n");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString());
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON\n");
      return;
    }

    // Only deploy on pushes to main
    if (payload.ref !== "refs/heads/main") {
      console.log(`[${new Date().toISOString()}] Push to ${payload.ref} — ignoring`);
      res.writeHead(200);
      res.end("Not main branch, skipping\n");
      return;
    }

    console.log(`[${new Date().toISOString()}] Push to main by ${payload.pusher?.name || "unknown"} — deploying`);

    // Spawn deploy script detached so we respond immediately
    const child = spawn("bash", [DEPLOY_SCRIPT], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Deploy triggered\n");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[webhook] Listening on 127.0.0.1:${PORT}`);
});
