'use strict';
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// The proxy is launched detached (docker exec -d), whose stderr is captured
// nowhere (docker logs only shows PID 1). So it reports its own state via marker
// files on tmpfs that the engine polls: a positive .ready on listen, .err (with the
// reason) on ANY startup failure, and .served — the append-only ledger of what it
// actually wrote. Without .ready/.err a crash and a slow bind are
// indistinguishable and the failure reason is lost; without .served the sealed
// artifact could only ever restate the PLAN ("this response would be served"),
// which is exactly the false attestation this file exists to prevent.
// The engine always uses /tmp (a tmpfs inside the container, so the ledger dies with
// it). NPMGUARD_STUB_DIR exists so the matcher and the ledger can be proven by
// running this exact file under a real node outside a container — the intent of a
// pattern is a property of this code, and the previous bug below survived precisely
// because nothing executed it without a whole sandbox.
const DIR = process.env.NPMGUARD_STUB_DIR || '/tmp';
const READY = DIR + '/npmguard-stub-proxy.ready';
const ERR = DIR + '/npmguard-stub-proxy.err';
const SERVED = DIR + '/npmguard-stub-proxy.served';

function fail(reason) {
  try { fs.writeFileSync(ERR, String(reason) + '\n'); } catch (_) { /* tmpfs full — nothing to do */ }
  process.stderr.write('[stub-proxy] fatal: ' + reason + '\n');
  process.exit(3);
}
process.on('uncaughtException', (e) => fail(e && e.stack ? e.stack : e));

let STUBS;
let PORT;
try {
  STUBS = JSON.parse(process.env.NPMGUARD_STUBS || '[]');
  PORT = Number(process.env.NPMGUARD_STUB_PORT) || 18080;
} catch (e) {
  fail('bad NPMGUARD_STUBS env: ' + e);
}

// `*` MUST be in this set. It is escaped here and turned back into `.*` by the
// caller; left unescaped it survives into the regex as a quantifier on whatever
// precedes it, so `http://host/latest/meta-data/*` compiled to "…/meta-data" plus
// zero-or-more slashes and matched no sub-path at all. Every wildcard stub in the
// recorded corpus was inert for that reason — a silent no-op of the same family as
// the proxy nothing ever reached.
function escapeRegex(value) {
  const SPECIAL = '.+*?^(){}|[]\\';
  let output = '';
  for (const character of value) {
    if (character === '$' || SPECIAL.indexOf(character) !== -1) output += '\\';
    output += character;
  }
  return output;
}

// Returns the INDEX of the matching stub, or -1. The index, not the pattern, is
// what the ledger records: two stubs may declare the same pattern, and the engine
// maps ledger rows back onto setupApplied.stubUrls positionally.
function matchStub(url) {
  for (let index = 0; index < STUBS.length; index += 1) {
    const expression = new RegExp('^' + escapeRegex(STUBS[index].pattern).replace(/\\\*/g, '.*') + '$');
    if (expression.test(url)) return index;
  }
  return -1;
}

// The hash the sealed artifact carries for this stub, computed over the response
// this process is about to write — status, body, and the headers as actually sent,
// in a fixed field order — so `responseHash` is a fact about the run. The engine
// never recomputes it from the experiment; a test recomputes it from the plan to
// prove that the canned response, and only the canned response, was served.
function responseHash(status, headers, body) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ status: status, body: body, headers: headers }))
    .digest('hex');
}

// Appended synchronously, in the same turn that writes the response — NOT from the
// response's 'finish' event. 'finish' fires a turn or more later, in this process,
// while the reader is a different process that only knows the client has its bytes:
// so a stub that did serve could be read as having served nothing, and the timeline
// would tell the judge the stubbed endpoint was never contacted while showing the
// request. A row therefore means "the proxy composed and wrote this response for a
// request matching this stub", which is exactly the claim `responseHash` makes, and
// it is decided by straight-line code rather than by scheduling.
function record(row) {
  try {
    fs.appendFileSync(SERVED, JSON.stringify(row) + '\n');
  } catch (e) {
    // A lost row UNDERSTATES what was served, which the engine reads as a coverage
    // gap (DEFER), never as a false attestation. Make the reason visible anyway.
    process.stderr.write('[stub-proxy] ledger write failed: ' + e + '\n');
  }
}

const server = http.createServer((request, response) => {
  // Two request forms arrive here. Origin-form (`GET /path`, authority in the Host
  // header) is what the transparent netfilter redirect delivers — the client
  // believes it is talking to the real endpoint and addresses it accordingly.
  // Absolute-form (`GET http://host/path`) is what an explicit HTTP-proxy client
  // sends. Both must resolve to the authority the package asked for, port included:
  // that authority is what a stub pattern is matched against.
  const target = request.url && request.url.startsWith('http')
    ? request.url
    : 'http://' + (request.headers.host || 'unknown') + (request.url || '');
  const index = matchStub(target);
  const stub = index < 0 ? null : STUBS[index];
  process.stderr.write('[stub-proxy] ' + request.method + ' ' + target + ' -> ' + (stub ? 'stub#' + index : 'reject') + '\n');
  const status = stub ? (stub.responseStatus || 200) : 502;
  const headers = stub
    ? (stub.responseHeaders || { 'Content-Type': 'text/plain' })
    : { 'Content-Type': 'text/plain' };
  const body = stub
    ? (stub.responseBody || 'ok')
    : 'stub-proxy: no matching stub for ' + target;
  record({
    stub: index < 0 ? null : index,
    method: String(request.method || ''),
    url: target,
    status: status,
    responseHash: responseHash(status, headers, body),
  });
  response.writeHead(status, headers);
  response.end(body);
});

server.on('connect', (request, socket) => {
  // A CONNECT tunnel would have to terminate TLS with a certificate the client
  // trusts, and the sandbox deliberately ships no MitM CA. An https:// pattern is
  // therefore a coverage gap the engine reports (SetupError → DEFER), never a
  // silent no-op.
  process.stderr.write('[stub-proxy] CONNECT ' + request.url + ' (HTTPS MitM not supported)\n');
  socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  socket.destroy();
});

// A bind failure (EADDRINUSE, permission, …) arrives as an 'error' event, not a
// throw — without this handler it would be an unhandled 'error' and a silent death.
server.on('error', (e) => fail('listen error: ' + (e && e.stack ? e.stack : e)));
server.listen(PORT, '127.0.0.1', () => {
  try {
    fs.writeFileSync(READY, '');
  } catch (e) {
    fail('ready-marker write failed: ' + e);
  }
  process.stderr.write('[stub-proxy] listening on 127.0.0.1:' + PORT + '\n');
});
