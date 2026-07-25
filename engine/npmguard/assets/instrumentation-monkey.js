'use strict';

const _log = [];
const _originals = {};

// The `require` sensor is NOT installed here. It lives in
// instrumentation-require-hook.js, which docker.instrumentation_source
// concatenates AFTER every part of the instrument that requires anything of its
// own — so the first `require` event in the log is always the package's.

const fs = require('fs');
for (const method of ['readFileSync', 'writeFileSync', 'readFile', 'writeFile', 'accessSync', 'statSync']) {
  if (typeof fs[method] === 'function') {
    _originals['fs.' + method] = fs[method];
    fs[method] = function(path, ...args) {
      _log.push({ type: 'fs', method, path: String(path) });
      return _originals['fs.' + method].call(this, path, ...args);
    };
  }
}

// L4 network. Two rendering properties are load-bearing, both learned from real
// judgements on real malware:
//
//   * the logged authority must be the one the package ACTUALLY requested, port
//     included. A POST to http://localhost:9999/exfil logged as
//     http://localhost/exfil reads to the judge as a DIFFERENT endpoint, and
//     three judges refuted live credential exfiltration citing exactly that
//     mismatch.
//   * a default port must NEVER be synthesized. Rendering ":80"/":443" where the
//     package specified none is the same mismatch mirrored, and would refute a
//     hypothesis phrased around the bare host.
//
// The request body is captured (bounded) because "was the planted canary in the
// exfiltrated payload?" is otherwise unanswerable from any sensor layer. What is
// captured is what the package SUBMITTED to the request — L4 records the call,
// not its outcome, exactly as it does for fs.
const _BODY_CAP = 2048;        // bytes kept per request
const _BODY_TOTAL_CAP = 65536; // bytes kept per run — the hard bound on trace growth
let _bodyBudget = _BODY_TOTAL_CAP;

// Build the URL the way Node resolves the options itself: `hostname` wins over
// `host`, a "host:port" string is split rather than duplicated or dropped, a URL
// instance already carries its own authority, and a port is emitted only when
// the caller supplied one.
function _requestedUrl(proto, options) {
  if (typeof options === 'string') return options;
  if (!options || typeof options !== 'object') return proto + '://';
  if (typeof options.href === 'string' && options.href) return options.href;
  let host = options.hostname;
  let port = options.port;
  if (!host && typeof options.host === 'string' && options.host) {
    const mark = options.host.lastIndexOf(':');
    if (mark > options.host.lastIndexOf(']')) {
      host = options.host.slice(0, mark);
      if (port === undefined || port === null || port === '') port = options.host.slice(mark + 1);
    } else {
      host = options.host;
    }
  }
  host = typeof host === 'string' && host ? host : 'localhost';
  if (host.indexOf(':') !== -1 && host.charAt(0) !== '[') host = '[' + host + ']';
  const authority = port === undefined || port === null || String(port) === ''
    ? host
    : host + ':' + port;
  return proto + '://' + authority + (options.path || options.pathname || '/');
}

// Accumulate what the package writes to the request. Wrapping the INSTANCE's
// write/end (not the prototype) keeps this scoped to requests we logged. The
// package is assumed hostile, so nothing in here may throw into its call stack:
// a crashed instrument loses the whole run's evidence.
function _captureRequestBody(entry, request) {
  try {
    let kept = Buffer.alloc(0);
    let total = 0;
    const record = function (chunk, encoding) {
      try {
        if (chunk === null || chunk === undefined) return;
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
        total += buffer.length;
        const room = Math.min(_BODY_CAP - kept.length, _bodyBudget);
        if (room > 0) {
          const slice = buffer.slice(0, room);
          kept = Buffer.concat([kept, slice]);
          _bodyBudget -= slice.length;
        }
        entry.body = kept.toString('utf8');
        entry.bodyBytes = total;
      } catch (e) {}
    };
    const originalWrite = request.write;
    const originalEnd = request.end;
    request.write = function (chunk, encoding, ...rest) {
      record(chunk, encoding);
      return originalWrite.call(this, chunk, encoding, ...rest);
    };
    request.end = function (chunk, encoding, ...rest) {
      // end() also accepts a bare callback — that is not a body chunk.
      if (typeof chunk !== 'function') record(chunk, encoding);
      return originalEnd.call(this, chunk, encoding, ...rest);
    };
  } catch (e) {}
}

for (const proto of ['http', 'https']) {
  try {
    const mod = require(proto);
    const _origRequest = mod.request;
    mod.request = function(options, ...args) {
      // request(url, options, cb): the method rides on the SECOND argument, so
      // reading it only off the first logs every such POST as a GET.
      const extra = args.length && args[0] && typeof args[0] === 'object' ? args[0] : null;
      const method = (options && typeof options === 'object' && options.method)
        || (extra && extra.method)
        || 'GET';
      const entry = { type: 'network', method: String(method), url: _requestedUrl(proto, options) };
      _log.push(entry);
      const request = _origRequest.call(this, options, ...args);
      _captureRequestBody(entry, request);
      return request;
    };
    // Node's http.get calls the module-INTERNAL request(), not the exported one,
    // so patching `request` alone leaves every http.get/https.get invisible at
    // L4 (the running example's IMDS probe was captured only by pcap). Route it
    // through the patched request, exactly as Node's own get does.
    const _patchedRequest = mod.request;
    mod.get = function(...callArgs) {
      const request = _patchedRequest.apply(this, callArgs);
      request.end();
      return request;
    };
  } catch {}
}

const cp = require('child_process');
for (const method of ['exec', 'execSync', 'spawn', 'spawnSync', 'fork']) {
  if (typeof cp[method] === 'function') {
    _originals['cp.' + method] = cp[method];
    cp[method] = function(cmd, ...args) {
      _log.push({ type: 'process', method, cmd: String(cmd) });
      return _originals['cp.' + method].call(this, cmd, ...args);
    };
  }
}

process.env = new Proxy(process.env, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && prop !== 'toJSON' && !prop.startsWith('_')) {
      _log.push({ type: 'env', key: prop });
    }
    return Reflect.get(target, prop, receiver);
  }
});

const _origEval = global.eval;
global.eval = function(code) {
  _log.push({ type: 'eval', code: String(code).slice(0, 200) });
  return _origEval.call(this, code);
};

try {
  const crypto = require('crypto');
  for (const method of ['createDecipheriv', 'createDecipher', 'createCipheriv', 'createHash']) {
    if (typeof crypto[method] === 'function') {
      _originals['crypto.' + method] = crypto[method];
      crypto[method] = function(algo, ...args) {
        _log.push({ type: 'crypto', method, algo: String(algo) });
        return _originals['crypto.' + method].call(this, algo, ...args);
      };
    }
  }
} catch {}

const _origSetTimeout = global.setTimeout;
const _origSetInterval = global.setInterval;
global.setTimeout = function(fn, ms, ...args) {
  _log.push({ type: 'timer', kind: 'setTimeout', ms });
  return _origSetTimeout.call(this, fn, ms, ...args);
};
global.setInterval = function(fn, ms, ...args) {
  _log.push({ type: 'timer', kind: 'setInterval', ms });
  return _origSetInterval.call(this, fn, ms, ...args);
};
