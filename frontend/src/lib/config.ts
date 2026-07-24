/**
 * Runtime configuration accessor. App code never reads import.meta.env
 * directly — the same build artifact must run behind the vite dev proxy, the
 * engine's static server, and the e2e harness. A host page may inject
 * window.__NPMGUARD_CONFIG__ before the bundle loads.
 */

declare global {
  interface Window {
    __NPMGUARD_CONFIG__?: { apiBase?: string };
  }
}

export function apiBase(): string {
  if (typeof window !== "undefined" && window.__NPMGUARD_CONFIG__?.apiBase) {
    return window.__NPMGUARD_CONFIG__.apiBase;
  }
  return "/api";
}
