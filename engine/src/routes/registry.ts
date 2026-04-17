import { Hono } from "hono";

import { resolveTarballUrl } from "../phases/resolve.js";
import { listReports, loadReport } from "../report-store.js";
import { PackageName } from "./validation.js";

export const registryRoutes = new Hono();

registryRoutes.get("/packages", (c) => {
  return c.json({ packages: listReports() });
});

// Supports scoped packages: /package/@scope/name/report
registryRoutes.get("/package/:name{.+}/report", (c) => {
  const packageName = c.req.param("name");
  const version = c.req.query("version");

  const result = loadReport(packageName, version || undefined);
  if (!result) {
    return c.json(
      { error: `No audit report found for ${packageName}${version ? `@${version}` : ""}` },
      404,
    );
  }

  return c.json({ report: result.report, version: result.version, packageName });
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
