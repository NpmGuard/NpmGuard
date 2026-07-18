const path = require("path");
const { pathToFileURL } = require("url");

const PACKAGES_DIR = process.env.NPMGUARD_PACKAGES_DIR
  ? path.resolve(process.env.NPMGUARD_PACKAGES_DIR)
  : path.resolve(__dirname, "..", "test-fixtures");

/**
 * Run a test package in an isolated module environment.
 * Tests should use vi.spyOn, vi.useFakeTimers(), vi.stubEnv(), and MSW for mocking.
 */
async function runPackage(packageName, entryPoint) {
  const packageDir = path.join(PACKAGES_DIR, packageName);
  const entryPath = path.join(packageDir, entryPoint);

  // Clear Node.js require cache for the package directory to ensure test isolation
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(packageDir)) {
      delete require.cache[key];
    }
  }

  try {
    return require(entryPath);
  } catch (e) {
    if (e && (e.code === "ERR_REQUIRE_ESM" || e.code === "ERR_REQUIRE_ASYNC_MODULE")) {
      try {
        return await import(pathToFileURL(entryPath).href);
      } catch (importError) {
        console.error(
          `[sandbox-runner] import("${entryPath}") threw: ${importError instanceof Error ? importError.message : importError}`,
        );
        throw importError;
      }
    }

    // Loading failures must fail the proof immediately. Returning an
    // {__error} object turns a missing entrypoint into an assertion mismatch,
    // hiding the real reason why the package behavior was never triggered.
    console.error(`[sandbox-runner] require("${entryPath}") threw: ${e instanceof Error ? e.message : e}`);
    throw e;
  }
}

module.exports = { runPackage };
