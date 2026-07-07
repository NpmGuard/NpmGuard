import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

// Same root as report-store's data dir: <repo-root>/data. Works from both
// engine/src (tsx dev) and engine/dist (built) — one level up is engine/,
// two levels up is the repo root.
const DB_PATH = path.resolve(import.meta.dirname, "../../data/npmguard.db");
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

export type DB = Database.Database;

/**
 * Open a database and bring it to the latest schema. Pass ":memory:" in
 * tests. The default path can be overridden with NPMGUARD_DB_PATH (used by
 * tests that need a file-backed db).
 */
export function openDb(dbPath: string = DB_PATH): DB {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Apply engine/migrations/NNN_*.sql files with NNN greater than the current
 * `user_version` pragma, each in its own transaction. PRAGMA user_version is
 * stored in the db header and rolls back with the transaction, so a failed
 * migration leaves the schema untouched.
 */
export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split("_")[0]!, 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
    console.log(`[db] applied migration ${file}`);
  }
}

let singleton: DB | null = null;

/** Process-wide database handle. Lazy so report-only code paths never open it. */
export function getDb(): DB {
  if (!singleton) {
    singleton = openDb(process.env.NPMGUARD_DB_PATH ?? DB_PATH);
  }
  return singleton;
}

/** Test hook: swap the singleton (e.g. for an in-memory db). Returns the old one. */
export function setDbForTesting(db: DB | null): DB | null {
  const old = singleton;
  singleton = db;
  return old;
}

export function nowIso(): string {
  return new Date().toISOString();
}
