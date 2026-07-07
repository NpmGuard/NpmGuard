import { randomBytes } from "node:crypto";
import { getDb, nowIso } from "./db.js";

// DB-backed opaque-token sessions (spec §5.2). The token is 32 random bytes
// hex, stored in an HttpOnly cookie; logout = row delete. 30-day sliding
// expiry, extended at most once per day to avoid write churn.

export const SESSION_COOKIE = "ng_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXTEND_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export function createSession(userId: number): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  getDb()
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, userId, expiresAt);
  return { token, expiresAt };
}

export function getSessionUser(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.expires_at, u.id, u.login, u.name, u.email, u.avatar_url
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as
    | { expires_at: string; id: number; login: string; name: string | null; email: string | null; avatar_url: string | null }
    | undefined;
  if (!row) return null;

  if (row.expires_at <= nowIso()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }

  // Sliding expiry — extend when the stored expiry lags the target by >1 day
  const target = Date.now() + SESSION_TTL_MS;
  if (target - new Date(row.expires_at).getTime() > EXTEND_THRESHOLD_MS) {
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(
      new Date(target).toISOString(),
      token,
    );
  }

  return { id: row.id, login: row.login, name: row.name, email: row.email, avatarUrl: row.avatar_url };
}

export function deleteSession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/** Periodic cleanup — mirror of payment-map cleanup pattern in index.ts. */
export function cleanupExpiredSessions(): void {
  getDb().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}
