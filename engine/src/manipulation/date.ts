import type { SetupResult } from "./types.js";

/** Path to libfaketime's shared object — Dockerfile.sandbox symlinks it here. */
const LIBFAKETIME = "/usr/lib/libfaketime.so.1";

/**
 * Fake the system date inside the container via libfaketime (LD_PRELOAD).
 *
 * Covers `Date.now()`, `new Date()`, `gettimeofday(2)`, `clock_gettime(CLOCK_REALTIME)`.
 * Does NOT affect `CLOCK_MONOTONIC`. Documented v1 gap — good enough for
 * almost all time-gated payloads, which check wall-clock time.
 *
 * libfaketime's `@<date>` prefix freezes time at the given point. It expects
 * a space-separated `YYYY-MM-DD HH:MM:SS` (UTC) format, not ISO 8601, so we
 * convert here. The caller still provides a standard ISO timestamp.
 */
export function setDate(iso: string): SetupResult {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`setDate: invalid ISO timestamp: ${iso}`);
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  const faketime = `@${y}-${mo}-${da} ${h}:${mi}:${s}`;

  return {
    envs: { FAKETIME: faketime },
    ldPreload: LIBFAKETIME,
    applied: { date: iso },
  };
}
