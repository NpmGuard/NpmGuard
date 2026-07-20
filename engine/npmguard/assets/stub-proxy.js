'use strict';
const http = require('http');
const STUBS = JSON.parse(process.env.NPMGUARD_STUBS || '[]');
const PORT = Number(process.env.NPMGUARD_STUB_PORT) || 18080;

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

server.listen(PORT, '127.0.0.1');
