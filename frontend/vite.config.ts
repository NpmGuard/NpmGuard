/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The dev server proxies /api/* to the Python engine (uvicorn :8000). The
// rewrite strips the /api prefix; the engine ALSO mirrors /api/* itself, so
// this is belt-and-braces — both shapes reach the same routes. The same built
// bundle runs behind this proxy, the engine's static server, and the e2e
// harness, so app code reads the base via lib/config.ts, never import.meta.env.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the wire contract from SOURCE, never from shared/dist.
      //
      // The package's `main` points at dist/, which is gitignored and only
      // written when tsc EMITS — so `tsc --noEmit`, or simply editing a schema,
      // leaves a stale dist that vite/vitest would happily import. That failure
      // is silent and looks like "the schema I just wrote doesn't exist".
      // Aliasing to src makes the stale state unreachable rather than adding a
      // build step someone has to remember. Typechecking still goes through the
      // tsconfig project reference, so both paths see the same files.
      "@npmguard/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 3000,
    allowedHosts: ["npmguard.com", "www.npmguard.com"],
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
