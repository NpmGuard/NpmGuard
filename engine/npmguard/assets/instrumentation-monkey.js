'use strict';

const _log = [];
const _originals = {};
const Module = require('module');
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  _log.push({ type: 'require', module: request, from: parent?.filename || '<root>' });
  return _origResolve.call(this, request, parent, ...rest);
};

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
