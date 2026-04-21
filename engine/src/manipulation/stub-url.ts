import type { StubUrlRef } from "@npmguard/shared";
import { sha256Hex } from "../evidence/hashing.js";
import { dockerExec } from "../sandbox/docker.js";
import { writeFileInContainer } from "./helpers.js";
import type { SetupContext, SetupResult } from "./types.js";

export interface StubUrlSpec {
  /** URL pattern; `*` is the wildcard. Example: `"*attacker.com/*"`. */
  pattern: string;
  responseStatus?: number;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
}

const PROXY_PORT = 18080;
const PROXY_PATH = "/tmp/npmguard-stub-proxy.js";

/**
 * Route HTTP traffic from the target package through an in-container stub
 * proxy that returns canned responses for matching URLs.
 *
 * v1 scope: HTTP only. HTTPS requests go through the proxy as CONNECT; the
 * proxy records the destination but does NOT MitM (no CA cert, no payload
 * visibility). HTTPS destinations are still observable via the CONNECT log
 * (and via L2 pcap SNI once Sprint 4 lands). Full HTTPS payload MitM is v2.
 *
 * Packages that bypass `HTTP_PROXY` / `HTTPS_PROXY` (raw sockets, DNS exfil,
 * pinned agents) are not intercepted — the proxy has no knowledge of them.
 */
export function stubUrl(specs: readonly StubUrlSpec[]): SetupResult {
  const proxyScript = buildProxyScript();
  const stubsJson = JSON.stringify(
    specs.map((s) => ({
      pattern: s.pattern,
      responseStatus: s.responseStatus ?? 200,
      responseBody: s.responseBody ?? "ok",
      responseHeaders: s.responseHeaders ?? { "Content-Type": "text/plain" },
    })),
  );

  const refs: StubUrlRef[] = specs.map((s) => ({
    pattern: s.pattern,
    responseHash: sha256Hex(
      JSON.stringify({
        status: s.responseStatus ?? 200,
        body: s.responseBody ?? "ok",
        headers: s.responseHeaders ?? {},
      }),
    ),
  }));

  return {
    envs: {
      HTTP_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
      HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
      http_proxy: `http://127.0.0.1:${PROXY_PORT}`,
      https_proxy: `http://127.0.0.1:${PROXY_PORT}`,
      NO_PROXY: "",
      NPMGUARD_STUBS: stubsJson,
      NPMGUARD_STUB_PORT: String(PROXY_PORT),
    },
    postStart: async (ctx: SetupContext) => {
      await writeFileInContainer(ctx.containerName, PROXY_PATH, proxyScript);
      await dockerExec(
        ["exec", "-d", ctx.containerName, "node", PROXY_PATH],
        10_000,
      );
      await waitForProxyReady(ctx.containerName);
    },
    applied: { stubUrls: refs },
  };
}

/**
 * Poll the proxy's TCP port until it accepts connections or times out.
 * Uses Node's net module inside the container — no extra tooling needed.
 */
async function waitForProxyReady(containerName: string): Promise<void> {
  const readinessScript = `require('net').connect(${PROXY_PORT}, '127.0.0.1', () => process.exit(0)).on('error', () => process.exit(1))`;
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await dockerExec(
      ["exec", containerName, "node", "-e", readinessScript],
      2_000,
    );
    if (res.exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`stubUrl: proxy on 127.0.0.1:${PROXY_PORT} did not become ready in ~1.5s`);
}

function buildProxyScript(): string {
  // NOTE: assembled as a plain string (not a tagged template) because the
  // proxy code contains literal `${}` inside a regex char class that a
  // template literal would try to interpolate.
  return [
    `'use strict';`,
    `const http = require('http');`,
    ``,
    `const STUBS = JSON.parse(process.env.NPMGUARD_STUBS || '[]');`,
    `const PORT = Number(process.env.NPMGUARD_STUB_PORT) || 18080;`,
    ``,
    `function escapeRegex(s) {`,
    `  const SPECIAL = '.+?^(){}|[]\\\\';`,
    `  let out = '';`,
    `  for (const ch of s) {`,
    `    if (ch === '$' || SPECIAL.indexOf(ch) !== -1) out += '\\\\';`,
    `    out += ch;`,
    `  }`,
    `  return out;`,
    `}`,
    ``,
    `function matchStub(url) {`,
    `  for (const stub of STUBS) {`,
    `    const rx = new RegExp('^' + escapeRegex(stub.pattern).replace(/\\\\\\*/g, '.*') + '$');`,
    `    if (rx.test(url)) return stub;`,
    `  }`,
    `  return null;`,
    `}`,
    ``,
    `const server = http.createServer((req, res) => {`,
    `  const target = req.url && req.url.startsWith('http')`,
    `    ? req.url`,
    `    : 'http://' + (req.headers.host || 'unknown') + (req.url || '');`,
    ``,
    `  const stub = matchStub(target);`,
    `  process.stderr.write('[stub-proxy] ' + req.method + ' ' + target + ' -> ' + (stub ? 'stub' : 'reject') + '\\n');`,
    ``,
    `  if (stub) {`,
    `    res.writeHead(stub.responseStatus || 200, stub.responseHeaders || { 'Content-Type': 'text/plain' });`,
    `    res.end(stub.responseBody || 'ok');`,
    `    return;`,
    `  }`,
    `  res.writeHead(502, { 'Content-Type': 'text/plain' });`,
    `  res.end('stub-proxy: no matching stub for ' + target);`,
    `});`,
    ``,
    `server.on('connect', (req, socket) => {`,
    `  // HTTPS CONNECT — log destination, reject (no MitM in v1)`,
    `  process.stderr.write('[stub-proxy] CONNECT ' + req.url + ' (HTTPS MitM not in v1)\\n');`,
    `  socket.write('HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n');`,
    `  socket.destroy();`,
    `});`,
    ``,
    `server.listen(PORT, '127.0.0.1', () => {`,
    `  process.stderr.write('[stub-proxy] listening on 127.0.0.1:' + PORT + '\\n');`,
    `});`,
  ].join("\n");
}
