import type { DatadogSample } from "./types.js";

// ---------------------------------------------------------------------------
// Fixture-name conventions for Datadog samples.
//
// NpmGuard's resolvePackage() treats any package whose name starts with
// `test-pkg-` as a local fixture under sandbox/test-fixtures/. We extend
// that convention here with a `test-pkg-bench-dd-` prefix so the bench
// fixtures don't collide with the engine's own hand-crafted test packages.
//
// The engine's PackageName zod regex allows only `[a-z0-9-._~]` (with an
// optional `@scope/`). We sanitise aggressively so any Datadog package
// name — including uppercase, slashes, scoped names — produces a fixture
// directory name that will pass that check.
// ---------------------------------------------------------------------------

const FIXTURE_PREFIX = "test-pkg-bench-dd";

function sanitise(part: string): string {
  return part
    .toLowerCase()
    .replace(/@/g, "at-")
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A short class indicator: `c` for compromised_lib, `m` for malicious_intent. */
function classCode(c: DatadogSample["className"]): "c" | "m" {
  return c === "compromised_lib" ? "c" : "m";
}

/** Build the directory name (and the packageName the engine will be asked
 *  to audit). Always begins with `test-pkg-bench-dd-` so an operator
 *  scanning the fixtures dir can identify benchmark-injected fixtures. */
export function fixtureNameFor(sample: DatadogSample): string {
  const safeName = sanitise(sample.packageName);
  const safeVersion = sanitise(sample.version);
  return `${FIXTURE_PREFIX}-${classCode(sample.className)}-${safeName}-v${safeVersion}`;
}
