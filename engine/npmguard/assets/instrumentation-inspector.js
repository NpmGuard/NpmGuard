try {
  const _inspector = require('inspector');
  const _session = new _inspector.Session();
  _session.connect();
  _session.post('Debugger.enable', function () {});
  _session.post('Debugger.setSkipAllPauses', { skip: true }, function () {});
  _session.on('Debugger.scriptParsed', function (msg) {
    const p = (msg && msg.params) || {};
    const url = p.url || '';
    if (url.indexOf('node:') === 0 || url.indexOf('file:') === 0 || url.charAt(0) === '/' || url.indexOf('node_modules') !== -1) return;
    const entry = { type: 'script', url: url, source: '', len: 0 };
    _log.push(entry);
    try {
      _session.post('Debugger.getScriptSource', { scriptId: p.scriptId }, function (err, res) {
        if (!err && res && typeof res.scriptSource === 'string') {
          const src = res.scriptSource;
          entry.len = src.length;
          entry.source = src.length > 65536 ? src.slice(0, 65536) : src;
        }
      });
    } catch (e) {}
  });
} catch (e) {}
