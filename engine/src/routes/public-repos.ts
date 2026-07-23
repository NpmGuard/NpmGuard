import { Hono } from "hono";

import { assertPublicRepoAuditCap, CapExceededError } from "../caps.js";
import { loadCertificate } from "../certificate-store.js";
import { getDb } from "../db.js";
import { publicOctokit } from "../github/app.js";
import { fetchPublicRepoInputs, PublicRepoFileTooLargeError } from "../github/content.js";
import {
  manifestRanges,
  parseLockfile,
  UnsupportedLockfileError,
} from "../lockfile/index.js";
import { requireUser, userHasInstallation } from "./panel.js";
import {
  computePublicScanRollup,
  createPublicRepoScan,
  findRunningPublicScan,
  InvalidPublicRepoReferenceError,
  parsePublicRepoReference,
} from "../scan/public-repo-scan.js";

export const publicRepoRoutes = new Hono();

interface PublicScanRow {
  id: number;
  installation_id: number;
  account_login: string;
  requested_by: number;
  github_repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  commit_sha: string | null;
  lockfile_path: string;
  lockfile_sha: string;
  status: string;
  total: number;
  cached: number;
  audited: number;
  failed: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function serializeScan(row: PublicScanRow) {
  return {
    id: row.id,
    installationId: row.installation_id,
    accountLogin: row.account_login,
    requestedBy: row.requested_by,
    githubRepoId: row.github_repo_id,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    htmlUrl: row.html_url,
    defaultBranch: row.default_branch,
    commitSha: row.commit_sha,
    lockfilePath: row.lockfile_path,
    lockfileSha: row.lockfile_sha,
    status: row.status,
    total: row.total,
    cached: row.cached,
    audited: row.audited,
    failed: row.failed,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    rollup: computePublicScanRollup(row.id),
  };
}

function scanSelect(): string {
  return `SELECT prs.*, i.account_login
          FROM public_repo_scans prs
          JOIN installations i ON i.id = prs.installation_id`;
}

publicRepoRoutes.get("/panel/public-repos", (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const rows = getDb()
    .prepare(
      `${scanSelect()}
       JOIN user_installations ui ON ui.installation_id = prs.installation_id
       WHERE ui.user_id = ?
       ORDER BY prs.started_at DESC
       LIMIT 20`,
    )
    .all(user.id) as PublicScanRow[];
  return c.json({ scans: rows.map(serializeScan) });
});

publicRepoRoutes.get("/panel/public-repos/:id", (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const row = getDb()
    .prepare(`${scanSelect()} WHERE prs.id = ?`)
    .get(Number(c.req.param("id"))) as PublicScanRow | undefined;
  if (!row || !userHasInstallation(user.id, row.installation_id)) {
    return c.json({ error: "Public audit not found" }, 404);
  }

  const dependencies = getDb()
    .prepare(
      `SELECT psi.name, psi.version, psi.direct, psi.range, psi.cached,
              pv.verdict, pv.reason, pv.evidence_count, pv.audited_at,
              EXISTS(
                SELECT 1 FROM jobs j
                WHERE j.package_name = psi.name AND j.version = psi.version
                  AND j.state IN ('queued', 'running')
              ) AS active
       FROM public_repo_scan_items psi
       LEFT JOIN package_verdicts pv ON pv.name = psi.name AND pv.version = psi.version
       WHERE psi.scan_id = ?
       ORDER BY
         CASE pv.verdict
           WHEN 'DANGEROUS' THEN 4 WHEN 'SUSPECT' THEN 3
           WHEN 'UNKNOWN' THEN 2 WHEN 'SAFE' THEN 1 ELSE 2
         END DESC,
         psi.direct DESC, psi.name
       LIMIT 500`,
    )
    .all(row.id) as Array<{
    name: string;
    version: string;
    direct: number;
    range: string | null;
    cached: number;
    verdict: string | null;
    reason: string | null;
    evidence_count: number | null;
    audited_at: string | null;
    active: number;
  }>;

  return c.json({
    scan: serializeScan(row),
    dependenciesTruncated: row.total > dependencies.length,
    dependencies: dependencies.map((dep) => {
      const certificate = loadCertificate(dep.name, dep.version);
      return {
        name: dep.name,
        version: dep.version,
        direct: dep.direct === 1,
        range: dep.range,
        cached: dep.cached === 1,
        verdict: dep.verdict,
        reason: dep.reason,
        evidenceCount: dep.evidence_count ?? 0,
        auditedAt: dep.audited_at,
        active: dep.active === 1,
        certificate: certificate
          ? {
              certificateHash: certificate.certificateHash,
              status: certificate.anchor ? "anchored" : "pending",
              anchor: certificate.anchor ?? null,
            }
          : null,
      };
    }),
  });
});

publicRepoRoutes.post("/panel/public-repos/scan", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  let body: { repository?: unknown; installationId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.repository !== "string") {
    return c.json({ error: "Repository is required" }, 400);
  }
  const installationId = Number(body.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return c.json({ error: "Choose the account whose audit allowance should be used" }, 400);
  }
  if (!userHasInstallation(user.id, installationId)) {
    return c.json({ error: "GitHub installation not found" }, 404);
  }

  try {
    const reference = parsePublicRepoReference(body.repository);
    const octo = publicOctokit();

    // No auth is attached to this client. A private repository therefore
    // returns 404 regardless of the signed-in user's personal permissions.
    const { data: repo } = await octo.rest.repos.get({
      owner: reference.owner,
      repo: reference.repo,
    });
    if (repo.private) return c.json({ error: "Only public repositories can be audited here" }, 403);

    const canonicalOwner = repo.owner.login;
    const canonicalName = repo.name;
    const canonicalFullName = repo.full_name;
    const running = findRunningPublicScan(installationId, canonicalFullName);
    if (running) {
      return c.json({ error: "An audit is already running for this repository", scanId: running.id }, 409);
    }
    assertPublicRepoAuditCap(installationId, repo.id);

    const inputs = await fetchPublicRepoInputs(
      octo,
      canonicalOwner,
      canonicalName,
      repo.default_branch,
    );
    if (!inputs) {
      return c.json(
        {
          error:
            "No supported lockfile found — commit package-lock.json, pnpm-lock.yaml, or yarn.lock at the repo root",
        },
        422,
      );
    }

    const account = getDb()
      .prepare("SELECT account_login FROM installations WHERE id = ?")
      .get(installationId) as { account_login: string };
    const deps = parseLockfile(
      inputs.lockfile.path,
      inputs.lockfile.content,
      manifestRanges(inputs.manifest),
    );
    const scanId = createPublicRepoScan({
      installationId,
      requestedBy: user.id,
      githubRepoId: repo.id,
      owner: canonicalOwner,
      name: canonicalName,
      fullName: canonicalFullName,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      commitSha: null,
      lockfilePath: inputs.lockfile.path,
      lockfileSha: inputs.lockfile.sha,
      deps,
      accountLogin: account.account_login,
    });
    return c.json({ scanId }, 201);
  } catch (err) {
    if (err instanceof InvalidPublicRepoReferenceError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof CapExceededError) {
      return c.json(
        {
          error: err.message,
          cap: true,
          resource: err.resource,
          installationId: err.installationId,
          entitlements: err.entitlements,
        },
        402,
      );
    }
    if (err instanceof UnsupportedLockfileError || err instanceof PublicRepoFileTooLargeError) {
      return c.json({ error: err.message }, 422);
    }
    const status = (err as { status?: number }).status;
    if (status === 404) return c.json({ error: "Public repository not found" }, 404);
    if (status === 403 || status === 429) {
      return c.json({ error: "GitHub public API limit reached — try again shortly" }, 429);
    }
    console.error("[public-scan] failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Public repository audit failed — see engine logs" }, 502);
  }
});
