import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTesting, type DB } from "../db.js";
import { createSession, SESSION_COOKIE } from "../session.js";
import { publicRepoRoutes } from "./public-repos.js";

let app: Hono;
let db: DB;
let cookie: string;

beforeEach(() => {
  db = openDb(":memory:");
  setDbForTesting(db);
  app = new Hono();
  app.route("/", publicRepoRoutes);

  db.prepare("INSERT INTO users (id, login) VALUES (7, 'alice'), (8, 'bob')").run();
  db.prepare(
    `INSERT INTO installations (id, account_login, account_type)
     VALUES (42, 'alice-org', 'Organization'), (43, 'bob-org', 'Organization')`,
  ).run();
  db.prepare("INSERT INTO user_installations (user_id, installation_id) VALUES (7, 42), (8, 43)").run();
  cookie = `${SESSION_COOKIE}=${createSession(7).token}`;

  const insert = db.prepare(
    `INSERT INTO public_repo_scans (
       id, installation_id, requested_by, github_repo_id, owner, name, full_name,
       html_url, default_branch, lockfile_path, lockfile_sha, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'main', 'package-lock.json', 'sha', 'done')`,
  );
  insert.run(1, 42, 7, 1001, "public", "visible", "public/visible", "https://github.com/public/visible");
  insert.run(2, 43, 8, 1002, "public", "hidden", "public/hidden", "https://github.com/public/hidden");
});

describe("public repository route authorization", () => {
  it("requires a signed-in user", async () => {
    expect((await app.request("/panel/public-repos")).status).toBe(401);
  });

  it("lists only scans charged to an installation the user can access", async () => {
    const response = await app.request("/panel/public-repos", { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scans: Array<{ id: number; fullName: string }> };
    expect(body.scans).toEqual([expect.objectContaining({ id: 1, fullName: "public/visible" })]);
  });

  it("does not expose another installation's report", async () => {
    const response = await app.request("/panel/public-repos/2", { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  it("rejects charging another installation before contacting GitHub", async () => {
    const response = await app.request("/panel/public-repos/scan", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ repository: "openai/openai-node", installationId: 43 }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects non-GitHub repository URLs before contacting the network", async () => {
    const response = await app.request("/panel/public-repos/scan", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ repository: "https://gitlab.com/acme/repo", installationId: 42 }),
    });
    expect(response.status).toBe(400);
  });
});
