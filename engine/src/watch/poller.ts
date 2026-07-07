import { config } from "../config.js";
import { getDb, nowIso } from "../db.js";
import { enqueueAuditJobs } from "../jobs/queue.js";
import { getVerdict } from "../verdict-index.js";

// Registry-watch (spec §5.6, provocation 1 — the headline of Protect): the
// CLI guards the install moment; this guards the publish moment. Every
// distinct package used by a protected repo is polled with If-None-Match —
// 304s are free, so a few thousand watched packages cost almost nothing per
// cycle. New versions are audited the moment they appear; a DANGEROUS
// verdict fans out via alerts/notify.ts (which computes range exposure).
// Watch audits are not charged to org budgets — they fill the shared cache.

const REGISTRY = "https://registry.npmjs.org";

/** Reconcile watched_packages with the deps of protected repos. Called after
 *  every index update (scan, webhook, protect toggle). */
export function syncWatchedPackages(): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO watched_packages (name)
       SELECT DISTINCT rd.name FROM repo_deps rd
       JOIN repos r ON r.id = rd.repo_id
       WHERE r.protected_at IS NOT NULL`,
    ).run();
    db.prepare(
      `DELETE FROM watched_packages WHERE name NOT IN (
         SELECT DISTINCT rd.name FROM repo_deps rd
         JOIN repos r ON r.id = rd.repo_id
         WHERE r.protected_at IS NOT NULL
       )`,
    ).run();
  })();
}

interface WatchRow {
  name: string;
  etag: string | null;
  known_versions: string;
  last_checked_at: string | null;
}

async function pollPackage(row: WatchRow): Promise<void> {
  const db = getDb();
  // Scoped names need the internal slash encoded: @scope%2Fname
  const url = `${REGISTRY}/${row.name.replace("/", "%2F")}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(row.etag ? { "if-none-match": row.etag } : {}),
    },
  });

  if (res.status === 304) {
    db.prepare("UPDATE watched_packages SET last_checked_at = ? WHERE name = ?").run(
      nowIso(),
      row.name,
    );
    return;
  }
  if (!res.ok) {
    console.warn(`[watch] registry ${res.status} for ${row.name}`);
    return;
  }

  const meta = (await res.json()) as { versions?: Record<string, unknown> };
  const versions = Object.keys(meta.versions ?? {});
  const etag = res.headers.get("etag");

  const firstSight = row.last_checked_at === null;
  const known: string[] = JSON.parse(row.known_versions || "[]");
  const knownSet = new Set(known);
  const fresh = firstSight ? [] : versions.filter((v) => !knownSet.has(v));

  db.prepare(
    "UPDATE watched_packages SET etag = ?, known_versions = ?, last_checked_at = ? WHERE name = ?",
  ).run(etag, JSON.stringify(versions), nowIso(), row.name);

  if (fresh.length === 0) return;
  console.log(`[watch] ${row.name}: new version${fresh.length > 1 ? "s" : ""} ${fresh.join(", ")}`);

  // Proactive audits — before anyone installs. org/scan null: shared-cache fill.
  enqueueAuditJobs(
    fresh
      .filter((v) => !getVerdict(row.name, v))
      .map((v) => ({ packageName: row.name, version: v, org: null, scanId: null })),
  );
}

let polling = false;

export async function pollOnce(): Promise<void> {
  if (polling) return; // a slow cycle must not stack on itself
  polling = true;
  try {
    const rows = getDb().prepare("SELECT * FROM watched_packages").all() as WatchRow[];
    for (const row of rows) {
      try {
        await pollPackage(row);
      } catch (err) {
        console.warn(`[watch] poll failed for ${row.name}:`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    polling = false;
  }
}

export function startRegistryWatch(): void {
  const intervalMs = config.watchIntervalMin * 60_000;
  setInterval(() => void pollOnce(), intervalMs);
  // First cycle shortly after boot — initializes known_versions baselines
  setTimeout(() => void pollOnce(), 30_000);
  console.log(`[watch] registry watch every ${config.watchIntervalMin}min`);
}
