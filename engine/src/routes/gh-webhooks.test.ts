import { sign } from "@octokit/webhooks-methods";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db.js";

// Spec §9 test 3: invalid HMAC → 401 with no side effects; valid deliveries
// mutate installation/repo state. GitHub App env is pinned before the module
// graph loads (config reads at import).

const SECRET = "webhook-test-secret";
process.env.NPMGUARD_GITHUB_APP_ID = "12345";
process.env.NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH = "/dev/null";
process.env.NPMGUARD_GITHUB_CLIENT_ID = "Iv1.test";
process.env.NPMGUARD_GITHUB_CLIENT_SECRET = "clientsecret";
process.env.NPMGUARD_ENCRYPTION_KEY = "cd".repeat(32);
process.env.NPMGUARD_GITHUB_WEBHOOK_SECRET = SECRET;

let app: Hono;
let db: DB;
let openDb: typeof import("../db.js").openDb;
let setDbForTesting: typeof import("../db.js").setDbForTesting;

beforeAll(async () => {
  ({ openDb, setDbForTesting } = await import("../db.js"));
  const { ghWebhookRoutes } = await import("./gh-webhooks.js");
  app = new Hono();
  app.route("/", ghWebhookRoutes);
});

beforeEach(() => {
  db = openDb(":memory:");
  setDbForTesting(db);
});

async function deliver(event: string, payload: unknown, opts: { badSig?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const signature = opts.badSig
    ? "sha256=" + "0".repeat(64)
    : await sign(SECRET, body);
  return app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

const INSTALLATION = {
  id: 42,
  account: { login: "acme", type: "Organization" },
  suspended_at: null,
};

describe("signature verification", () => {
  it("rejects invalid signatures with 401 and no side effects", async () => {
    const res = await deliver(
      "installation",
      { action: "created", installation: INSTALLATION, repositories: [] },
      { badSig: true },
    );
    expect(res.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) c FROM installations").get()).toMatchObject({ c: 0 });
  });

  it("rejects missing signatures", async () => {
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "ping" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

describe("installation lifecycle", () => {
  it("created → upserts installation + its repos", async () => {
    const res = await deliver("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [
        { id: 1001, name: "web", full_name: "acme/web", private: true },
      ],
    });
    expect(res.status).toBe(202);
    expect(db.prepare("SELECT account_login FROM installations WHERE id = 42").get()).toMatchObject(
      { account_login: "acme" },
    );
    expect(db.prepare("SELECT full_name, private FROM repos WHERE id = 1001").get()).toMatchObject({
      full_name: "acme/web",
      private: 1,
    });
  });

  it("deleted → cascades installation, repos, deps, and inactive billing state", async () => {
    await deliver("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [{ id: 1001, name: "web", full_name: "acme/web", private: false }],
    });
    db.prepare("INSERT INTO repo_deps (repo_id, name, version, direct) VALUES (1001, 'x', '1.0.0', 0)").run();
    db.prepare(
      `INSERT INTO billing_accounts (
         installation_id, stripe_subscription_id, subscription_status
       ) VALUES (42, 'sub_canceled', 'canceled')`,
    ).run();

    const res = await deliver("installation", { action: "deleted", installation: INSTALLATION });
    expect(res.status).toBe(202);
    expect(db.prepare("SELECT COUNT(*) c FROM repos").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM repo_deps").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM billing_accounts").get()).toMatchObject({ c: 0 });
  });

  it("keeps installation data when an active subscription cannot be canceled", async () => {
    await deliver("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [{ id: 1001, name: "web", full_name: "acme/web", private: false }],
    });
    db.prepare(
      `INSERT INTO billing_accounts (
         installation_id, stripe_subscription_id, subscription_status
       ) VALUES (42, 'sub_active', 'active')`,
    ).run();

    const res = await deliver("installation", { action: "deleted", installation: INSTALLATION });
    expect(res.status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) c FROM installations").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM billing_accounts").get()).toMatchObject({ c: 1 });
  });

  it("installation_repositories removed → prunes exactly those repos", async () => {
    await deliver("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [
        { id: 1, name: "a", full_name: "acme/a", private: false },
        { id: 2, name: "b", full_name: "acme/b", private: false },
      ],
    });
    await deliver("installation_repositories", {
      action: "removed",
      installation: INSTALLATION,
      repositories_removed: [{ id: 1, name: "a", full_name: "acme/a", private: false }],
    });
    const rows = db.prepare("SELECT id FROM repos ORDER BY id").all() as Array<{ id: number }>;
    expect(rows).toEqual([{ id: 2 }]);
  });
});

describe("push handling", () => {
  it("push to an unprotected repo is acknowledged but starts no scan", async () => {
    await deliver("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [{ id: 1001, name: "web", full_name: "acme/web", private: false }],
    });
    const res = await deliver("push", {
      ref: "refs/heads/main",
      after: "a".repeat(40),
      repository: { id: 1001, name: "web", full_name: "acme/web", private: false, default_branch: "main" },
      commits: [{ added: [], modified: ["package-lock.json"], removed: [] }],
    });
    expect(res.status).toBe(202);
    // handler runs async — give it a beat
    await new Promise((r) => setTimeout(r, 50));
    expect(db.prepare("SELECT COUNT(*) c FROM scans").get()).toMatchObject({ c: 0 });
  });

  it("invalidates cached auditability when dependency files change", async () => {
    await deliver("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [{ id: 1001, name: "web", full_name: "acme/web", private: false }],
    });
    db.prepare(
      `UPDATE repos
       SET lockfile_path = 'package-lock.json', auditability_checked_at = ?
       WHERE id = 1001`,
    ).run(new Date().toISOString());

    await deliver("push", {
      ref: "refs/heads/main",
      after: "b".repeat(40),
      repository: {
        id: 1001,
        name: "web",
        full_name: "acme/web",
        private: false,
        default_branch: "main",
      },
      commits: [{ added: [], modified: ["package-lock.json"], removed: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      db.prepare("SELECT auditability_checked_at FROM repos WHERE id = 1001").get(),
    ).toMatchObject({ auditability_checked_at: null });
  });
});
