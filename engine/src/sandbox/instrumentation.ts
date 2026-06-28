/** JS instrumentation module — monkey-patches sensitive Node.js APIs.
 *  Injected via `node --require /tmp/_instrument.js <entrypoint>`.
 *  This is runtime JS, NOT TypeScript — kept as a string constant. */

export const INSTRUMENTATION_JS = String.raw`
'use strict';

const _log = [];
const _originals = {};

// --- Module loading ---
const Module = require('module');
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  _log.push({ type: 'require', module: request, from: parent?.filename || '<root>' });
  return _origResolve.call(this, request, parent, ...rest);
};

// --- Filesystem ---
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

// --- Network ---
for (const proto of ['http', 'https']) {
  try {
    const mod = require(proto);
    const _origRequest = mod.request;
    mod.request = function(options, ...args) {
      const url = typeof options === 'string' ? options : proto + '://' + (options.hostname || options.host) + (options.path || '/');
      _log.push({ type: 'network', method: options.method || 'GET', url });
      return _origRequest.call(this, options, ...args);
    };
  } catch {}
}

// --- Process spawning ---
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

// --- Environment access ---
const _envHandler = {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && prop !== 'toJSON' && !prop.startsWith('_')) {
      _log.push({ type: 'env', key: prop });
    }
    return Reflect.get(target, prop, receiver);
  }
};
process.env = new Proxy(process.env, _envHandler);

// --- Dynamic code execution ---
const _origEval = global.eval;
global.eval = function(code) {
  _log.push({ type: 'eval', code: String(code).slice(0, 200) });
  return _origEval.call(this, code);
};

// --- Crypto ---
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

// --- Timers ---
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

// --- Flush on exit ---
process.on('exit', () => {
  try {
    process.stdout.write('\n__NPMGUARD_TRACE__' + JSON.stringify(_log) + '__NPMGUARD_TRACE_END__\n');
  } catch {}
});
`;

/** Timer-advancing wrapper using a self-contained pure-JS fake clock.
 *  Runs inside the hermetic sandbox (--network=none, read-only, no node_modules),
 *  so it must not depend on any external module. */
export function buildTimerAdvanceJs(entrypoint: string, advanceMs: number): string {
  const safeEntrypoint = JSON.stringify("./" + entrypoint);
  const safeMs = Number(advanceMs);
  return `
'use strict';
// Capture the REAL setTimeout before any global reassignment so the kill switch
// below fires on the real event loop, not the virtual fake clock.
const _realSetTimeout = setTimeout;

// Minimal self-contained fake clock (no external deps). Drives virtual time so
// that delayed/interval malware payloads execute synchronously during tick().
const clock = (function () {
  let now = 0;
  let nextId = 1;
  let timers = [];
  const _RealDate = Date;

  function insert(timer) {
    timers.push(timer);
    timers.sort(function (a, b) { return (a.callAt - b.callAt) || (a.id - b.id); });
    return timer.id;
  }
  function setTimeoutImpl(fn, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    const delay = Math.max(0, Number(ms) || 0);
    return insert({ id: nextId++, callAt: now + delay, fn: fn, args: args, interval: undefined });
  }
  function setIntervalImpl(fn, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    const delay = Math.max(1, Number(ms) || 1);
    return insert({ id: nextId++, callAt: now + delay, fn: fn, args: args, interval: delay });
  }
  function clearImpl(id) {
    timers = timers.filter(function (t) { return t.id !== id; });
  }

  function FakeDate() {
    if (arguments.length === 0) return new _RealDate(now);
    return new (Function.prototype.bind.apply(_RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
  }
  FakeDate.prototype = _RealDate.prototype;
  FakeDate.now = function () { return now; };
  FakeDate.parse = _RealDate.parse;
  FakeDate.UTC = _RealDate.UTC;

  function tick(ms) {
    const target = now + Math.max(0, Number(ms) || 0);
    while (timers.length > 0 && timers[0].callAt <= target) {
      const timer = timers.shift();
      now = timer.callAt;
      if (timer.interval !== undefined) {
        timer.callAt = now + timer.interval;
        insert(timer);
      }
      try { timer.fn.apply(null, timer.args); } catch (e) {}
    }
    now = target;
  }

  return {
    setTimeout: setTimeoutImpl,
    setInterval: setIntervalImpl,
    clearTimeout: clearImpl,
    clearInterval: clearImpl,
    Date: FakeDate,
    tick: tick,
  };
})();

global.setTimeout = clock.setTimeout;
global.setInterval = clock.setInterval;
global.clearTimeout = clock.clearTimeout;
global.clearInterval = clock.clearInterval;
global.Date = clock.Date;

require(${safeEntrypoint});

clock.tick(${safeMs});

_realSetTimeout(() => process.exit(0), 100);
`;
}
