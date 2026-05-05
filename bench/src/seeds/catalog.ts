import type { SeedCatalog } from "../types.js";

/**
 * Seed catalogue for the NpmGuard benchmark, dataset version 0.1.0.
 *
 * Selection criteria (METHODOLOGY.md §4):
 *   1. Currently published, non-deprecated.
 *   2. ≥10k weekly downloads.
 *   3. Behavioural diversity — pure utilities, network, fs, crypto, build,
 *      native bindings, ESM-vs-CJS dual modes.
 *   4. Loadable in isolation: `node -e "require('<name>')"` succeeds.
 *   5. Source available in the published tarball.
 *
 * The `integrity` field is populated by `npm run lock` from the
 * registry's published `dist.integrity`. Empty strings are placeholders
 * that the fetcher refuses to accept.
 *
 * To add a seed: append the entry with `integrity: ""`, run `npm run lock`,
 * commit the result.
 */
export const SEEDS: SeedCatalog = [
  // ── Tier 1: simple, no I/O on load ────────────────────────────────────
  {
    name: "is-number",
    version: "7.0.0",
    integrity: "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "tiny", "utility"],
    description: "Returns true if the value is a finite number.",
  },
  {
    name: "ms",
    version: "2.1.3",
    integrity: "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "tiny", "time"],
    description: "Tiny millisecond conversion utility.",
  },
  {
    name: "lodash.merge",
    version: "4.6.2",
    integrity: "sha512-0KpjqXRVvrYyCsX1swR/XTK0va6VQkQM6MNo7PqW77ByjAhoARA8EfrP1N4+KlKj8YS0ZUCtRT/YUuhyYDujIQ==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "utility", "lodash-modular"],
    description: "Deep-merge utility from lodash, individually published.",
  },
  {
    name: "qs",
    version: "6.13.1",
    integrity: "sha512-EJPeIn0CYrGu+hli1xilKAPXODtJ12T0sP63Ijx2/khC2JtuaN3JyNIpvmnkmaEtha9ocbG4A4cMcr+TvqvwQg==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "parser", "query-string"],
    description: "Querystring parsing and stringifying with nested objects.",
  },
  {
    name: "mime-types",
    version: "2.1.35",
    integrity: "sha512-ZDY+bPm5zTTF+YpCrAU9nK0UgICYPT0QtT1NZWFv4s++TNkcgVaT0g6+4R2uI4MjQjzysHB1zxuWL50hzaeXiw==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "lookup", "data-table"],
    description: "MIME-type lookup tables.",
  },
  {
    name: "semver",
    version: "7.6.3",
    integrity: "sha512-oVekP1cKtI+CTDvHWYFUcMtsK/00wmAEfyqKfNdARm8u1wNVhSgaX7A8d4UuIlUI5e84iEwOhs7ZPYRmzU9U6A==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "parser", "version"],
    description: "Semantic version parsing and comparison.",
  },
  {
    name: "cookie",
    version: "1.0.2",
    integrity: "sha512-9Kr/j4O16ISv8zBBhJoi4bXOYNTkFLOqSL3UDB0njXxCXNezjeyVrJyGOWtgfs/q2km1gwBcfH8q1yEGoMYunA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "parser"],
    description: "HTTP cookie parsing/serialization.",
  },
  {
    name: "escape-string-regexp",
    version: "4.0.0",
    integrity: "sha512-TtpcNJ3XAzx3Gq8sWRzJaVajRs0uVxA2YAkdb1jm2YkPz4G6egUFAyA3n5vtEIZefPk5Wa4UXbKuS5fKkJWdgA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "tiny", "regex"],
    description: "Escape RegExp special characters in a string.",
  },
  {
    name: "picocolors",
    version: "1.1.1",
    integrity: "sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "terminal", "tiny"],
    description: "Smaller, faster alternative to chalk.",
  },
  {
    name: "uuid",
    version: "9.0.1",
    integrity: "sha512-b+1eJOlsR9K8HJpow9Ok3fiWOWSIcIzXodvv0rQjVoOVNpWMpxf1wZNpt4y9h10odCNrqnYp1OBzRktckBe3sA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: true, spawn: false, lifecycleScripts: false },
    tags: ["crypto-legitimate", "uuid"],
    description: "UUID generation; legitimately uses crypto.",
  },

  // ── Tier 2: utilities with light or legitimate I/O ────────────────────
  {
    name: "dotenv",
    version: "16.4.7",
    integrity: "sha512-47qPchRCykZC03FhkYAhrvwU4xDBFIj1QPqaarj6mdM/hgUzfPHcpkHJOn3mJAufFeeAxAzeGsr5X0M4k6fLZQ==",
    form: "cjs",
    profile: { network: false, fs: true, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["fs-legitimate", "config"],
    description: "Loads environment variables from .env files.",
  },
  {
    name: "debug",
    version: "4.3.7",
    integrity: "sha512-Er2nc/H7RrMXZBFCEim6TCmMk02Z8vLC2Rbi1KEBggpo0fS6l0S1nnapwmIi3yW/+GOJap1Krg4w0Hg80oCqgQ==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "logging"],
    description: "Tiny JavaScript debugging utility.",
  },
  {
    name: "chalk",
    version: "4.1.2",
    integrity: "sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["terminal", "colors"],
    description: "Terminal string styling done right (last CJS major).",
  },
  {
    name: "commander",
    version: "12.1.0",
    integrity: "sha512-Vw8qHK3bZM9y/P10u3Vib8o/DdkvA2OtPtZvD871QKjy74Wj1WSKFILMPRPSdUSx5RFK1arlJzEtA4PkFgnbuA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["cli", "parser"],
    description: "CLI argument parsing framework.",
  },
  {
    name: "glob",
    version: "10.4.5",
    integrity: "sha512-7Bv8RF0k6xjo7d4A/PxYLbUCfb6c+Vpd2/mB2yRDlew7Jb5hEXiCD9ibfO7wpk8i4sevK6DFny9h7EYbM3/sHg==",
    form: "dual",
    profile: { network: false, fs: true, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["fs-legitimate", "filesystem"],
    description: "Match files using shell glob patterns.",
  },
  {
    name: "cross-spawn",
    version: "7.0.6",
    integrity: "sha512-uV2QOWP2nWzsy2aMp8aRibhi9dlzF5Hgh5SHaB9OiTGEyDTiJJyx0uy51QXdyWbtAHNua4XJzUKca3OzKUd3vA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: true, lifecycleScripts: false },
    tags: ["spawn-legitimate", "child-process"],
    description: "Cross-platform child_process.spawn replacement.",
  },
  {
    name: "fs-extra",
    version: "11.2.0",
    integrity: "sha512-PmDi3uwK5nFuXh7XDTlVnS17xJS7vW36is2+w3xcv8SVxiB4NyATf4ctkVY5bkSjX0Y4nbvZCq1/EjtEyr9ktw==",
    form: "cjs",
    profile: { network: false, fs: true, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["fs-legitimate", "filesystem"],
    description: "node fs module helpers (copy, move, ensureDir, etc.).",
  },
  {
    name: "mkdirp",
    version: "3.0.1",
    integrity: "sha512-+NsyUUAZDmo6YVHzL/stxSu3t9YS1iljliy3BSDrXJ/dkn1KYdmtZODGGjLcc9XLgVVpH4KshHB8XmZgMhaBXg==",
    form: "dual",
    profile: { network: false, fs: true, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["fs-legitimate", "filesystem", "tiny"],
    description: "Recursive mkdir, like `mkdir -p`.",
  },

  // ── Tier 3: heavier, network/crypto-using ─────────────────────────────
  {
    name: "axios",
    version: "1.7.9",
    integrity: "sha512-LhLcE7Hbiryz8oMDdDptSrWowmB4Bl6RCt6sIJKpRB4XtVf0iEgewX3au/pJqm+Py1kCASkb/FFKjxQaLtxJvw==",
    form: "cjs",
    profile: { network: true, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["network-legitimate", "http"],
    description: "Promise-based HTTP client.",
  },
  {
    name: "node-fetch",
    version: "2.7.0",
    integrity: "sha512-c4FRfUm/dbcWZ7U+1Wq0AwCyFL+3nt2bEw05wfxSz+DWpWsitgmSgYmy2dQdWyKC1694ELPqMs/YzUSNozLt8A==",
    form: "cjs",
    profile: { network: true, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["network-legitimate", "http"],
    description: "Bring `window.fetch` to Node.js (last CJS major).",
  },
  {
    name: "bcryptjs",
    version: "2.4.3",
    integrity: "sha512-V/Hy/X9Vt7f3BbPJEi8BdVFMByHi+jNXrYkW3huaybV/kQ0KJg0Y6PkEMbn+zeT+i+SiKZ/HMqJGIIt4LZDqNQ==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: true, spawn: false, lifecycleScripts: false },
    tags: ["crypto-legitimate", "auth"],
    description: "Pure-JS bcrypt implementation.",
  },
  {
    name: "jsonwebtoken",
    version: "9.0.2",
    integrity: "sha512-PRp66vJ865SSqOlgqS8hujT5U4AOgMfhrwYIuIhfKaoSCZcirrmASQr8CX7cUg+RMih+hgznrjp99o+W4pJLHQ==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: true, spawn: false, lifecycleScripts: false },
    tags: ["crypto-legitimate", "auth", "jwt"],
    description: "JSON Web Token implementation.",
  },
  {
    name: "zod",
    version: "3.23.8",
    integrity: "sha512-XBx9AXhXktjUqnepgTiE5flcKIYWi/rme0Eaj+5Y0lftuGBq+jyRu/md4WnuxqgP1ubdpNCsYEYPxrzVHD8d6g==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "validation"],
    description: "TypeScript-first schema validation.",
  },
  {
    name: "joi",
    version: "17.13.3",
    integrity: "sha512-otDA4ldcIx+ZXsKHWmp0YizCweVRZG96J10b0FevjfuncLO1oX59THoAmHkNubYJ+9gWsYsp5k8v4ib6oDv1fA==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "validation"],
    description: "Schema validation for JavaScript.",
  },
  {
    name: "p-limit",
    version: "5.0.0",
    integrity: "sha512-/Eaoq+QyLSiXQ4lyYV23f14mZRQcXnxfHrN0vCai+ak9G0pp9iEQukIIZq5NccEvwRB8PUnZT0KsOoDCINS1qQ==",
    form: "cjs",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: false },
    tags: ["pure", "concurrency", "tiny"],
    description: "Run multiple promise-returning & async functions with concurrency limit.",
  },

  // ── Tier 4: native bindings — runtime-evidence verifiability is N/A ──
  {
    name: "bcrypt",
    version: "5.1.1",
    integrity: "sha512-AGBHOG5hPYZ5Xl9KXzU5iKq9516yEmvCKDg3ecP5kX2aB6UqTeXZxk2ELnDgDm6BQSMlLt9rDB4LoSMx0rYwww==",
    form: "native-binding",
    profile: { network: false, fs: false, crypto: true, spawn: false, lifecycleScripts: true },
    tags: ["native", "crypto-legitimate", "lifecycle-legitimate"],
    description: "Native bcrypt binding; has install lifecycle script.",
  },
  {
    name: "bufferutil",
    version: "4.0.8",
    integrity: "sha512-4T53u4PdgsXqKaIctwF8ifXlRTTmEPJ8iEPWFdGZvcf7sbwYo6FKFEX9eNNAnzFZ7EzJAQ3CJeOtCRA4rDp7Pw==",
    form: "native-binding",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: true },
    tags: ["native", "websocket-helper"],
    description: "Native helper for the `ws` websocket library.",
  },
  {
    name: "tree-sitter",
    version: "0.21.1",
    integrity: "sha512-7dxoA6kYvtgWw80265MyqJlkRl4yawIjO7S5MigytjELkX43fV2WsAXzsNfO7sBpPPCF5Gp0+XzHk0DwLCq3xQ==",
    form: "native-binding",
    profile: { network: false, fs: false, crypto: false, spawn: false, lifecycleScripts: true },
    tags: ["native", "parser"],
    description: "Native incremental parser bindings.",
  },
];

/** Number of seeds in the catalogue — handy for sanity checks. */
export const SEED_COUNT = SEEDS.length;
