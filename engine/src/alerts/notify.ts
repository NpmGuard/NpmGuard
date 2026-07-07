import semver from "semver";
import { getDb } from "../db.js";
import { sendDangerousEmail } from "./email.js";

// DANGEROUS fan-out (spec §3, data-flow 2). Called by the job workers when
// any audit — scan-triggered or registry-watch — lands a DANGEROUS verdict.
// Exposure semantics (spec §5.6 / provocation 1):
//   exact  — the version is in the repo's lockfile: it IS installed
//   range  — a protected repo's declared range would adopt it on next update
// Both get alert rows; emails go to every affected org's known users.

interface ExposedRepo {
  repoId: number;
  fullName: string;
  org: string;
  message: string;
}

export function handleDangerousVerdict(
  packageName: string,
  version: string,
  source: "scan" | "watch",
): void {
  const db = getDb();

  const exact = db
    .prepare(
      `SELECT r.id AS repoId, r.full_name AS fullName, i.account_login AS org
       FROM repo_deps rd
       JOIN repos r ON r.id = rd.repo_id
       JOIN installations i ON i.id = r.installation_id
       WHERE rd.name = ? AND rd.version = ?`,
    )
    .all(packageName, version) as Array<{ repoId: number; fullName: string; org: string }>;

  const exactIds = new Set(exact.map((r) => r.repoId));
  const exposed: ExposedRepo[] = exact.map((r) => ({
    ...r,
    message: `installed at ${version}`,
  }));

  // Range exposure only matters for protected repos (they're the ones
  // registry-watch guards); a poisoned version nobody has installed yet is
  // exactly the early warning this product sells.
  const rangeRows = db
    .prepare(
      `SELECT DISTINCT rd.range, r.id AS repoId, r.full_name AS fullName, i.account_login AS org
       FROM repo_deps rd
       JOIN repos r ON r.id = rd.repo_id
       JOIN installations i ON i.id = r.installation_id
       WHERE rd.name = ? AND rd.direct = 1 AND rd.range IS NOT NULL
         AND r.protected_at IS NOT NULL`,
    )
    .all(packageName) as Array<{ range: string; repoId: number; fullName: string; org: string }>;

  for (const row of rangeRows) {
    if (exactIds.has(row.repoId)) continue;
    let satisfies = false;
    try {
      satisfies = semver.satisfies(version, row.range, { includePrerelease: true });
    } catch {
      // non-semver range (git:, file:, workspace:) — not adoptable via registry
    }
    if (satisfies) {
      exposed.push({
        repoId: row.repoId,
        fullName: row.fullName,
        org: row.org,
        message: `range ${row.range} would adopt ${version} on next update`,
      });
    }
  }

  if (exposed.length === 0) return;

  const insertAlert = db.prepare(
    `INSERT INTO alerts (org, repo_id, package_name, version, verdict, kind, message)
     SELECT ?, ?, ?, ?, 'DANGEROUS', ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM alerts
       WHERE repo_id = ? AND package_name = ? AND version = ?
     )`,
  );
  const byOrg = new Map<string, ExposedRepo[]>();
  db.transaction(() => {
    for (const repo of exposed) {
      insertAlert.run(
        repo.org, repo.repoId, packageName, version, source, repo.message,
        repo.repoId, packageName, version,
      );
      const list = byOrg.get(repo.org) ?? [];
      list.push(repo);
      byOrg.set(repo.org, list);
    }
  })();

  for (const [org, repos] of byOrg) {
    const recipients = (
      db
        .prepare(
          `SELECT DISTINCT u.email FROM users u
           JOIN user_installations ui ON ui.user_id = u.id
           JOIN installations i ON i.id = ui.installation_id
           WHERE i.account_login = ? AND u.email IS NOT NULL`,
        )
        .all(org) as Array<{ email: string }>
    ).map((r) => r.email);

    void sendDangerousEmail(
      org,
      recipients,
      packageName,
      version,
      repos.map((r) => `${r.fullName}: ${r.message}`),
    );
  }

  console.log(
    `[alerts] DANGEROUS ${packageName}@${version} (${source}) — ${exposed.length} repos across ${byOrg.size} orgs`,
  );
}
