import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let temporaryDirectory: string | undefined;

afterEach(() => {
  delete process.env.NPMGUARD_BENCH_RESULTS_DIR;
  vi.resetModules();
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("GET /bench/results", () => {
  it("reads benchmark JSON files from the configured persistent directory", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "npmguard-bench-"));
    process.env.NPMGUARD_BENCH_RESULTS_DIR = temporaryDirectory;

    fs.writeFileSync(
      path.join(temporaryDirectory, "v1.json"),
      JSON.stringify({
        datasetVersion: "v1",
        results: [
          {
            fixtureName: "test-pkg-bench-dd-m-example-v1.0.0",
            entry: {
              pkg: { name: "example", version: "1.0.0" },
              expected: { verdict: "DANGEROUS" },
            },
            runs: [{ verdict: "DANGEROUS", durationMs: 123 }],
          },
        ],
      }),
    );

    const { benchRoutes } = await import("./bench.js");
    const app = new Hono().route("/", benchRoutes);
    const response = await app.request("/bench/results");
    const body = (await response.json()) as {
      resultsDir: string;
      runs: Array<{ file: string; totalRows: number }>;
    };

    expect(response.status).toBe(200);
    expect(body.resultsDir).toBe(temporaryDirectory);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ file: "v1.json", totalRows: 1 });
  });
});
