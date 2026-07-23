'use strict';
const http = require('http');
const fs = require('fs');

// The proxy is launched detached (docker exec -d), whose stderr is captured
// nowhere (docker logs only shows PID 1). So it reports its own state via two
// tmpfs marker files the readiness check polls: a positive .ready on listen, and
// .err (with the reason) on ANY startup failure. Without this, a crash and a slow
// bind are indistinguishable and the failure reason is lost.
const READY = '/tmp/npmguard-stub-proxy.ready';
const ERR = '/tmp/npmguard-stub-proxy.err';

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

function escapeRegex(value) {
  const SPECIAL = '.+?^(){}|[]\\';
  let output = '';
  for (const character of value) {
    if (character === '$' || SPECIAL.indexOf(character) !== -1) output += '\\';
    output += character;
  }
  return output;
}

function matchStub(url) {
  for (const stub of STUBS) {
    const expression = new RegExp('^' + escapeRegex(stub.pattern).replace(/\\\*/g, '.*') + '$');
    if (expression.test(url)) return stub;
  }
  return null;
}

const server = http.createServer((request, response) => {
  const target = request.url && request.url.startsWith('http')
    ? request.url
    : 'http://' + (request.headers.host || 'unknown') + (request.url || '');
  const stub = matchStub(target);
  process.stderr.write('[stub-proxy] ' + request.method + ' ' + target + ' -> ' + (stub ? 'stub' : 'reject') + '\n');
  if (stub) {
    response.writeHead(stub.responseStatus || 200, stub.responseHeaders || { 'Content-Type': 'text/plain' });
    response.end(stub.responseBody || 'ok');
    return;
  }
  response.writeHead(502, { 'Content-Type': 'text/plain' });
  response.end('stub-proxy: no matching stub for ' + target);
});

server.on('connect', (request, socket) => {
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
