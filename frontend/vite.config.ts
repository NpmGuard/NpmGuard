/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies /api/* to the Python engine (uvicorn :8000). The
// rewrite strips the /api prefix; the engine ALSO mirrors /api/* itself, so
// this is belt-and-braces — both shapes reach the same routes. The same built
// bundle runs behind this proxy, the engine's static server, and the e2e
// harness, so app code reads the base via lib/config.ts, never import.meta.env.
export default defineConfig({
  plugins: [react()],
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
