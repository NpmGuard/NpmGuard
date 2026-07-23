import { Hono } from "hono";

import { ensureAuditCertificate } from "../audit-persistence.js";
import { loadCertificateBatchManifest } from "../certificate-batch-store.js";
import { loadCertificate } from "../certificate-store.js";
import { resolveTarballUrl } from "../phases/resolve.js";
import { assessAuditReport } from "../proof-quality.js";
import { listReports, loadReport } from "../report-store.js";
import { loadStoragePublication } from "../storage-store.js";
import { PackageName, SemverVersion } from "./validation.js";

export const registryRoutes = new Hono();

registryRoutes.get("/packages", (c, next) => {
  if (c.req.header("accept")?.includes("text/html")) return next();
  const packages = listReports().map((report) => {
    const certificate = loadCertificate(report.packageName, report.version);
    return {
      ...report,
      certificate: certificate
        ? {
            status: certificate.anchor ? "anchored" : "pending_anchor",
            certificateHash: certificate.certificateHash,
            anchor: certificate.anchor ?? null,
          }
        : {
            status: "not_available",
            certificateHash: null,
            anchor: null,
          },
    };
  });
  return c.json({ packages });
});

// Supports scoped packages: /package/@scope/name/report
registryRoutes.get("/package/:name{.+}/report", (c) => {
  const packageName = c.req.param("name");
  const version = c.req.query("version");
  const nameCheck = PackageName.safeParse(packageName);
  if (!nameCheck.success) {
    return c.json({ error: "Invalid package name" }, 400);
  }
  if (version) {
    const versionCheck = SemverVersion.safeParse(version);
    if (!versionCheck.success) {
      return c.json({ error: "Invalid semver version" }, 400);
    }
  }

  const result = loadReport(packageName, version || undefined);
  if (!result) {
    return c.json(
      { error: `No audit report found for ${packageName}${version ? `@${version}` : ""}` },
      404,
    );
  }

  const certificate = ensureAuditCertificate(packageName, result.version);
  return c.json({
    report: result.report,
    assessment: assessAuditReport(result.report),
    version: result.version,
    packageName,
    certificate,
  });
});

registryRoutes.get("/package/:name{.+}/certificate", (c) => {
  const packageName = c.req.param("name");
  const version = c.req.query("version");
  const nameCheck = PackageName.safeParse(packageName);
  if (!nameCheck.success) {
    return c.json({ error: "Invalid package name" }, 400);
  }
  if (version) {
    const versionCheck = SemverVersion.safeParse(version);
    if (!versionCheck.success) {
      return c.json({ error: "Invalid semver version" }, 400);
    }
  }

  const report = loadReport(packageName, version || undefined);
  if (!report) {
    return c.json(
      { error: `No audit certificate found for ${packageName}${version ? `@${version}` : ""}` },
      404,
    );
  }
  const certificate = ensureAuditCertificate(packageName, report.version);
  if (!certificate) {
    return c.json({ error: "Certificate generation failed" }, 500);
  }
  return c.json({ certificate, version: report.version, packageName });
});

registryRoutes.get("/certificate-batches/:key", (c) => {
  const rawKey = c.req.param("key");
  const batchKey = rawKey.endsWith(".json") ? rawKey.slice(0, -5) : rawKey;

  try {
    const manifest = loadCertificateBatchManifest(batchKey);
    if (!manifest) {
      return c.json({ error: `No certificate batch found for ${batchKey}` }, 404);
    }
    return c.json(manifest);
  } catch {
    return c.json({ error: "Invalid certificate batch key" }, 400);
  }
});

registryRoutes.get("/package/:name{.+}/storage", (c) => {
  const packageName = c.req.param("name");
  const version = c.req.query("version");
  const nameCheck = PackageName.safeParse(packageName);
  if (!nameCheck.success) {
    return c.json({ error: "Invalid package name" }, 400);
  }
  if (version) {
    const versionCheck = SemverVersion.safeParse(version);
    if (!versionCheck.success) {
      return c.json({ error: "Invalid semver version" }, 400);
    }
  }

  const report = loadReport(packageName, version || undefined);
  if (!report) {
    return c.json(
      { error: `No audit report found for ${packageName}${version ? `@${version}` : ""}` },
      404,
    );
  }

  const storage = loadStoragePublication(packageName, report.version);
  if (!storage) {
    return c.json(
      { error: `No storage publication found for ${packageName}@${report.version}` },
      404,
    );
  }

  return c.json({ packageName, version: report.version, storage });
});

// Resolve "latest" (or a dist-tag) to a concrete semver — used by the frontend
// which can't hit registry.npmjs.org directly due to CSP.
registryRoutes.get("/resolve/:name{.+}", async (c) => {
  const name = c.req.param("name");
  const version = c.req.query("version") || "latest";
  const nameCheck = PackageName.safeParse(name);
  if (!nameCheck.success) {
    return c.json({ error: "Invalid package name" }, 400);
  }
  try {
    const { resolvedVersion } = await resolveTarballUrl(name, version);
    return c.json({ packageName: name, version: resolvedVersion });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Resolution failed" },
      404,
    );
  }
});
