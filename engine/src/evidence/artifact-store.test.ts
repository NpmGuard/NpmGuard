import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ArtifactStore } from "./artifact-store.js";
import { sha256Hex } from "./hashing.js";
import type { RunArtifact } from "@npmguard/shared";

function tmpStore(): { store: ArtifactStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npmguard-artifact-store-"));
  return { store: new ArtifactStore(root), root };
}

function baselineArtifact(): Omit<RunArtifact, "contentHash"> {
  return {
    runId: "run_test_001",
    triggerUsed: {
      kind: "entrypoint",
      target: "index.js",
      argv: [],
      stdin: null,
    },
    setupApplied: {
      env: {},
      date: null,
      plantFiles: [],
      stubUrls: [],
      hostname: null,
      locale: null,
      patches: [],
      preloadHash: null,
    },
    observe: { kernel: false, network: false, fsDiff: false, node: true, inspector: false },
    budget: { wallMs: 10_000, maxSyscalls: null, maxBytesCapture: null },
    wallMs: 42,
    exitCode: 0,
    timedOut: false,
    events: [],
    stdoutHash: null,
    stderrHash: null,
    fsDiffHash: null,
    pcapHash: null,
    straceLogHash: null,
    inspectorLogHash: null,
    eventSummary: {
      uniqueHosts: [],
      uniqueSyscalls: [],
      filesWritten: [],
      dnsQueries: [],
    },
    error: null,
    createdAt: "2026-04-18T10:00:00.000Z",
  };
}

describe("ArtifactStore blobs", () => {
  let store: ArtifactStore;
  let root: string;

  beforeEach(() => {
    ({ store, root } = tmpStore());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writeBlob returns the sha256 of input and stores the bytes", () => {
    const hash = store.writeBlob("hello");
    expect(hash).toBe(sha256Hex("hello"));
    expect(store.hasBlob(hash)).toBe(true);
    expect(store.readBlob(hash).toString("utf-8")).toBe("hello");
  });

  it("writeBlob is idempotent on identical content", () => {
    const hash1 = store.writeBlob("same-bytes");
    const hash2 = store.writeBlob("same-bytes");
    expect(hash1).toBe(hash2);
    expect(store.readBlob(hash1).toString("utf-8")).toBe("same-bytes");
  });

  it("supports extensions for human-readable blob names", () => {
    const hash = store.writeBlob("packet-data", "pcap");
    expect(store.hasBlob(hash, "pcap")).toBe(true);
    expect(store.hasBlob(hash)).toBe(false); // no extensionless file
    expect(store.readBlob(hash, "pcap").toString("utf-8")).toBe("packet-data");
  });

  it("writeBlob accepts Buffer input", () => {
    const hash = store.writeBlob(Buffer.from([0x00, 0x01, 0x02]));
    const read = store.readBlob(hash);
    expect(read).toEqual(Buffer.from([0x00, 0x01, 0x02]));
  });
});

describe("ArtifactStore RunArtifact", () => {
  let store: ArtifactStore;
  let root: string;

  beforeEach(() => {
    ({ store, root } = tmpStore());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writeArtifact computes a stable content hash and round-trips", () => {
    const hash = store.writeArtifact(baselineArtifact());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const read = store.readArtifact(hash);
    expect(read.contentHash).toBe(hash);
    expect(read.runId).toBe("run_test_001");
  });

  it("identical inputs produce identical hashes", () => {
    const a = store.writeArtifact(baselineArtifact());
    const b = store.writeArtifact(baselineArtifact());
    expect(a).toBe(b);
  });

  it("different inputs produce different hashes", () => {
    const a = store.writeArtifact(baselineArtifact());
    const modified = { ...baselineArtifact(), wallMs: 99 };
    const b = store.writeArtifact(modified);
    expect(a).not.toBe(b);
  });

  it("verifyArtifact returns true for untouched storage", () => {
    const hash = store.writeArtifact(baselineArtifact());
    expect(store.verifyArtifact(hash)).toBe(true);
  });

  it("verifyArtifact detects post-write tampering", () => {
    const hash = store.writeArtifact(baselineArtifact());
    const filePath = path.join(root, "artifacts", `${hash}.runartifact.json`);
    const current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    current.wallMs = 999;
    fs.writeFileSync(filePath, JSON.stringify(current));
    expect(store.verifyArtifact(hash)).toBe(false);
  });

  it("readArtifact rejects malformed JSON on disk via schema validation", () => {
    const hash = store.writeArtifact(baselineArtifact());
    const filePath = path.join(root, "artifacts", `${hash}.runartifact.json`);
    const current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    delete current.runId; // required field
    fs.writeFileSync(filePath, JSON.stringify(current));
    expect(() => store.readArtifact(hash)).toThrow();
  });
});
