// INSTALLED LAST, DELIBERATELY. (Concatenated into the instrument by
// docker.instrumentation_source — one module scope, `_log` comes from the monkey
// fragment, so there is no directive prologue here.)
//
// docker.instrumentation_source concatenates this fragment after the monkey
// patches and after the (optional) inspector, so everything the instrument
// requires for ITSELF — fs, http, https, child_process, crypto, module,
// inspector — is already resolved before the hook exists. The first `require`
// event in the trace is therefore the package's own.
//
// Installing it first (as the instrument used to) put `fs`, `http`, `https`,
// `child_process`, `crypto`, `inspector`, `module` at the head of EVERY timeline
// attributed to the package under audit. That is not cosmetic: a judge weights
// `child_process` and `crypto` as capabilities, so the timeline claimed the
// package reached for tools it never touched.
//
// Engine-side counterpart: evidence.parse_l4_trace asserts that no `require`
// event's `from` is the instrument, so re-ordering this fragment fails loud
// instead of silently misattributing capabilities again.
const _hookModule = require('module');
const _origResolveFilename = _hookModule._resolveFilename;
_hookModule._resolveFilename = function (request, parent, ...rest) {
  _log.push({ type: 'require', module: request, from: (parent && parent.filename) || '<root>' });
  return _origResolveFilename.call(this, request, parent, ...rest);
};
