import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

interface DemoRecording {
  packageName: string;
  report: {
    verdict: string;
    findings: unknown[];
    proofs: Array<{ kind: string; testCode?: string | null; testHash?: string | null }>;
  };
  events: Array<{ type: string; verdict?: string }>;
}

const DEMO_DATA_DIR = path.resolve(import.meta.dirname, "../demo-data");

function readRecording(packageName: string): DemoRecording {
  return JSON.parse(
    fs.readFileSync(path.join(DEMO_DATA_DIR, `${packageName}.json`), "utf8"),
  ) as DemoRecording;
}

describe("demo recordings", () => {
  it.each(["test-pkg-dom-inject", "test-pkg-env-exfil"])(
    "keeps the malicious control %s dangerous and reproducible",
    (packageName) => {
      const recording = readRecording(packageName);
      const finalVerdict = recording.events
        .filter((event) => event.type === "verdict_reached")
        .at(-1)?.verdict;

      expect(recording.report.verdict).toBe("DANGEROUS");
      expect(recording.report.findings.length).toBeGreaterThan(0);
      expect(recording.report.proofs.some((proof) => proof.kind === "TEST_CONFIRMED")).toBe(true);
      expect(finalVerdict).toBe("DANGEROUS");
    },
  );

  it.each(["react", "test-pkg-dom-inject", "test-pkg-env-exfil"])(
    "keeps the final event consistent with the saved report for %s",
    (packageName) => {
      const recording = readRecording(packageName);
      const finalVerdict = recording.events
        .filter((event) => event.type === "verdict_reached")
        .at(-1)?.verdict;

      expect(finalVerdict).toBe(recording.report.verdict);
    },
  );

  it("keeps the env-exfil demo proof hash consistent with its displayed test", () => {
    const recording = readRecording("test-pkg-env-exfil");
    const proof = recording.report.proofs.find(
      (candidate) => candidate.kind === "TEST_CONFIRMED",
    );

    expect(proof?.testCode).toBeTruthy();
    expect(proof?.testHash).toBe(
      createHash("sha256").update(proof!.testCode!).digest("hex"),
    );
  });
});
