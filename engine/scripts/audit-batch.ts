type BatchItem = {
  packageName: string;
  version?: string;
};

type BatchResult = BatchItem & {
  status: "skipped" | "accepted" | "completed" | "failed" | "timeout";
  verdict?: string;
  reportVersion?: string;
  error?: string;
  durationMs: number;
};

const DEFAULT_API = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_POLL_MS = 5_000;

function usage(): never {
  console.log(`Usage:
  npm run audit:batch -- [options] <pkg[@version]...>

Options:
  --api <url>          Engine API URL (default: ${DEFAULT_API})
  --file <path>        Newline-delimited packages to audit
  --timeout-ms <ms>    Per-package wait timeout (default: ${DEFAULT_TIMEOUT_MS})
  --poll-ms <ms>       Report polling interval (default: ${DEFAULT_POLL_MS})
  --no-skip            Re-audit even when a report already exists

Auth:
  Reads NPMGUARD_CRE_API_KEY from the environment. The key is sent as X-API-Key.

Examples:
  NPMGUARD_CRE_API_KEY=... npm run audit:batch -- is-number left-pad
  npm run audit:batch -- --api http://127.0.0.1:8000 --file packages.txt
`);
  process.exit(0);
}

function readArg(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function readPackageFile(filePath: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

function parsePackageSpec(spec: string): BatchItem {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("Empty package spec");

  const at = trimmed.startsWith("@")
    ? trimmed.indexOf("@", trimmed.indexOf("/") + 1)
    : trimmed.lastIndexOf("@");

  if (at > 0) {
    return {
      packageName: trimmed.slice(0, at),
      version: trimmed.slice(at + 1) || undefined,
    };
  }
  return { packageName: trimmed };
}

function packagePath(packageName: string): string {
  return packageName.split("/").map(encodeURIComponent).join("/");
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; ok: boolean; body: T | null; text: string }> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: T | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: resp.status, ok: resp.ok, body, text };
}

async function existingReport(api: string, item: BatchItem): Promise<{
  verdict?: string;
  version?: string;
} | null> {
  const url = new URL(`/package/${packagePath(item.packageName)}/report`, api);
  if (item.version) url.searchParams.set("version", item.version);
  const resp = await fetchJson<{ report?: { verdict?: string }; version?: string }>(
    url.toString(),
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`report lookup failed (${resp.status}): ${resp.text}`);
  return {
    verdict: resp.body?.report?.verdict,
    version: resp.body?.version,
  };
}

async function packageSummary(api: string, item: BatchItem): Promise<{
  verdict?: string;
  version?: string;
  auditedAt?: string;
} | null> {
  const resp = await fetchJson<{
    packages?: Array<{
      packageName: string;
      version: string;
      verdict: string;
      auditedAt: string;
    }>;
  }>(new URL("/packages", api).toString());
  if (!resp.ok) throw new Error(`package list failed (${resp.status}): ${resp.text}`);
  const match = resp.body?.packages?.find((pkg) =>
    pkg.packageName === item.packageName &&
    (!item.version || pkg.version === item.version),
  );
  if (!match) return null;
  return {
    verdict: match.verdict,
    version: match.version,
    auditedAt: match.auditedAt,
  };
}

async function enqueueAudit(api: string, item: BatchItem, creApiKey: string): Promise<void> {
  const resp = await fetchJson<{ error?: string; message?: string }>(
    new URL("/audit", api).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": creApiKey,
      },
      body: JSON.stringify({
        packageName: item.packageName,
        ...(item.version ? { version: item.version } : {}),
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(
      `audit enqueue failed (${resp.status}): ${resp.body?.message ?? resp.body?.error ?? resp.text}`,
    );
  }
}

async function waitForReport(
  api: string,
  item: BatchItem,
  timeoutMs: number,
  pollMs: number,
  previousAuditedAt?: string,
): Promise<{ verdict?: string; version?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (previousAuditedAt) {
      const summary = await packageSummary(api, item);
      if (summary && summary.auditedAt !== previousAuditedAt) return summary;
    } else {
      const report = await existingReport(api, item);
      if (report) return report;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();

  let api = process.env.NPMGUARD_API_URL ?? DEFAULT_API;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let pollMs = DEFAULT_POLL_MS;
  let skipExisting = true;
  const specs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--api") {
      api = readArg(args, i, arg);
      i++;
    } else if (arg === "--file") {
      specs.push(...await readPackageFile(readArg(args, i, arg)));
      i++;
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(readArg(args, i, arg));
      i++;
    } else if (arg === "--poll-ms") {
      pollMs = Number(readArg(args, i, arg));
      i++;
    } else if (arg === "--no-skip") {
      skipExisting = false;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      specs.push(arg);
    }
  }

  if (specs.length === 0) usage();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error("--poll-ms must be positive");

  const creApiKey = process.env.NPMGUARD_CRE_API_KEY;
  if (!creApiKey) {
    throw new Error("NPMGUARD_CRE_API_KEY is required");
  }

  const items = specs.map(parsePackageSpec);
  const results: BatchResult[] = [];
  console.log(`[audit:batch] api=${api} packages=${items.length} skipExisting=${skipExisting}`);

  for (const item of items) {
    const start = Date.now();
    const label = `${item.packageName}${item.version ? `@${item.version}` : ""}`;
    try {
      if (skipExisting) {
        const existing = await existingReport(api, item);
        if (existing) {
          console.log(`[audit:batch] skip ${label}: ${existing.verdict ?? "UNKNOWN"} @ ${existing.version ?? "unknown"}`);
          results.push({
            ...item,
            status: "skipped",
            verdict: existing.verdict,
            reportVersion: existing.version,
            durationMs: Date.now() - start,
          });
          continue;
        }
      }

      const previous = skipExisting ? null : await packageSummary(api, item);
      console.log(`[audit:batch] enqueue ${label}`);
      await enqueueAudit(api, item, creApiKey);
      const report = await waitForReport(
        api,
        item,
        timeoutMs,
        pollMs,
        previous?.auditedAt,
      );
      if (!report) {
        console.log(`[audit:batch] timeout ${label}`);
        results.push({ ...item, status: "timeout", durationMs: Date.now() - start });
        continue;
      }
      console.log(`[audit:batch] done ${label}: ${report.verdict ?? "UNKNOWN"} @ ${report.version ?? "unknown"}`);
      results.push({
        ...item,
        status: "completed",
        verdict: report.verdict,
        reportVersion: report.version,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[audit:batch] failed ${label}: ${error}`);
      results.push({ ...item, status: "failed", error, durationMs: Date.now() - start });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[audit:batch] summary ${JSON.stringify(counts)}`);
  console.log(JSON.stringify({ results }, null, 2));

  if (results.some((r) => r.status === "failed" || r.status === "timeout")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[audit:batch] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
