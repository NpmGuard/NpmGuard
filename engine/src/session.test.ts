import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTesting, type DB } from "./db.js";
import { cleanupExpiredSessions, createSession, deleteSession, getSessionUser } from "./session.js";

// Spec §9 test 10 (core semantics — the 401/403 route behavior sits on top
// of these): create → resolve, logout revokes, expiry invalidates.

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
  setDbForTesting(db);
  db.prepare(
    "INSERT INTO users (id, login, name, email, avatar_url) VALUES (7, 'wookie', 'W', 'w@x.com', null)",
  ).run();
});

describe("sessions", () => {
  it("creates an opaque token that resolves to the user", () => {
    const { token } = createSession(7);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const user = getSessionUser(token);
    expect(user).toMatchObject({ id: 7, login: "wookie", email: "w@x.com" });
  });

  it("returns null for unknown or missing tokens", () => {
    expect(getSessionUser(undefined)).toBeNull();
    expect(getSessionUser("f".repeat(64))).toBeNull();
  });

  it("logout revokes immediately", () => {
    const { token } = createSession(7);
    deleteSession(token);
    expect(getSessionUser(token)).toBeNull();
  });

  it("expired sessions are rejected and purged", () => {
    const { token } = createSession(7);
    db.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00Z' WHERE token = ?").run(token);
    expect(getSessionUser(token)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM sessions").get()).toMatchObject({ c: 0 });
  });

  it("cleanupExpiredSessions sweeps only expired rows", () => {
    const { token: live } = createSession(7);
    const { token: dead } = createSession(7);
    db.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00Z' WHERE token = ?").run(dead);
    cleanupExpiredSessions();
    expect(getSessionUser(live)).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM sessions").get()).toMatchObject({ c: 1 });
  });

  it("user deletion cascades to sessions", () => {
    const { token } = createSession(7);
    db.prepare("DELETE FROM users WHERE id = 7").run();
    expect(getSessionUser(token)).toBeNull();
  });
});
