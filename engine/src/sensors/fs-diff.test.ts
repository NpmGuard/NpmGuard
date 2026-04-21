import { describe, it, expect } from "vitest";
import { diffSnapshots, parseSnapshot } from "./fs-diff.js";

describe("parseSnapshot", () => {
  it("parses empty input to an empty map", () => {
    expect(parseSnapshot("").size).toBe(0);
    expect(parseSnapshot("\n\n").size).toBe(0);
  });

  it("parses a single record", () => {
    const m = parseSnapshot("/pkg/index.js\t42\t1634567890.123\n");
    expect(m.size).toBe(1);
    expect(m.get("/pkg/index.js")).toEqual({
      path: "/pkg/index.js",
      size: 42,
      mtime: 1634567890.123,
    });
  });

  it("parses multiple records", () => {
    const raw = [
      "/pkg/a.js\t100\t1700000000.0",
      "/pkg/b.js\t200\t1700000001.5",
      "/home/node/.npmrc\t50\t1700000002.1",
    ].join("\n");
    expect(parseSnapshot(raw).size).toBe(3);
  });

  it("ignores malformed lines silently", () => {
    const raw = [
      "/pkg/ok\t1\t1.0",
      "garbage-line-no-tabs",
      "/pkg/also-ok\t2\t2.0",
      "/pkg/missing-mtime\t3",
    ].join("\n");
    const m = parseSnapshot(raw);
    expect(m.size).toBe(2);
    expect(m.has("/pkg/ok")).toBe(true);
    expect(m.has("/pkg/also-ok")).toBe(true);
  });

  it("tolerates CR line endings", () => {
    const m = parseSnapshot("/pkg/win.js\t1\t1.0\r\n");
    expect(m.has("/pkg/win.js")).toBe(true);
  });

  it("handles paths containing spaces", () => {
    const m = parseSnapshot("/pkg/file with spaces.js\t10\t1.0");
    expect(m.get("/pkg/file with spaces.js")?.size).toBe(10);
  });
});

describe("diffSnapshots", () => {
  const runStart = 1_700_000_000;

  it("no changes → no events", () => {
    const pre = new Map([
      ["/pkg/a", { path: "/pkg/a", size: 1, mtime: runStart }],
    ]);
    const post = new Map([
      ["/pkg/a", { path: "/pkg/a", size: 1, mtime: runStart }],
    ]);
    expect(diffSnapshots(pre, post, runStart).events).toEqual([]);
  });

  it("new file → file_created event", () => {
    const pre = new Map();
    const post = new Map([
      ["/pkg/new", { path: "/pkg/new", size: 42, mtime: runStart + 1 }],
    ]);
    const { events } = diffSnapshots(pre, post, runStart);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("file_created");
    expect(events[0]!.normalized).toMatchObject({ path: "/pkg/new", size: 42 });
    expect(events[0]!.timestamp).toBe(1_000_000_000); // 1 sec × 1e9 ns
  });

  it("size change → file_modified event", () => {
    const pre = new Map([
      ["/pkg/a", { path: "/pkg/a", size: 100, mtime: runStart }],
    ]);
    const post = new Map([
      ["/pkg/a", { path: "/pkg/a", size: 200, mtime: runStart + 2 }],
    ]);
    const { events } = diffSnapshots(pre, post, runStart);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("file_modified");
    expect(events[0]!.normalized).toMatchObject({
      path: "/pkg/a",
      sizeBefore: 100,
      sizeAfter: 200,
    });
  });

  it("mtime change only (same size) → file_modified event", () => {
    const pre = new Map([
      ["/pkg/a", { path: "/pkg/a", size: 10, mtime: runStart }],
    ]);
    const post = new Map([
      ["/pkg/a", { path: "/pkg/a", size: 10, mtime: runStart + 5 }],
    ]);
    expect(diffSnapshots(pre, post, runStart).events[0]!.kind).toBe("file_modified");
  });

  it("removed file → file_deleted event with timestamp 0", () => {
    const pre = new Map([
      ["/pkg/gone", { path: "/pkg/gone", size: 7, mtime: runStart }],
    ]);
    const post = new Map();
    const { events } = diffSnapshots(pre, post, runStart);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("file_deleted");
    expect(events[0]!.timestamp).toBe(0);
    expect(events[0]!.normalized).toMatchObject({ path: "/pkg/gone", sizeBefore: 7 });
  });

  it("mixed add + modify + delete", () => {
    const pre = new Map([
      ["/pkg/keep", { path: "/pkg/keep", size: 10, mtime: runStart }],
      ["/pkg/modify", { path: "/pkg/modify", size: 20, mtime: runStart }],
      ["/pkg/gone", { path: "/pkg/gone", size: 30, mtime: runStart }],
    ]);
    const post = new Map([
      ["/pkg/keep", { path: "/pkg/keep", size: 10, mtime: runStart }],
      ["/pkg/modify", { path: "/pkg/modify", size: 50, mtime: runStart + 3 }],
      ["/pkg/new", { path: "/pkg/new", size: 40, mtime: runStart + 1 }],
    ]);
    const { events } = diffSnapshots(pre, post, runStart);
    const byKind = events.map((e) => e.kind);
    expect(byKind).toContain("file_created");
    expect(byKind).toContain("file_modified");
    expect(byKind).toContain("file_deleted");
    expect(events).toHaveLength(3);
  });

  it("created/modified events are ordered by mtime (relative timestamp)", () => {
    const pre = new Map();
    const post = new Map([
      ["/pkg/late", { path: "/pkg/late", size: 1, mtime: runStart + 10 }],
      ["/pkg/early", { path: "/pkg/early", size: 1, mtime: runStart + 1 }],
    ]);
    const { events } = diffSnapshots(pre, post, runStart);
    expect(events[0]!.normalized?.path).toBe("/pkg/early");
    expect(events[1]!.normalized?.path).toBe("/pkg/late");
  });

  it("mtime before runStart clamps timestamp to 0 (never negative)", () => {
    const pre = new Map();
    const post = new Map([
      ["/pkg/ancient", { path: "/pkg/ancient", size: 1, mtime: runStart - 5 }],
    ]);
    const { events } = diffSnapshots(pre, post, runStart);
    expect(events[0]!.timestamp).toBe(0);
  });

  it("rawDiff includes a line per change with tab-separated fields", () => {
    const pre = new Map([
      ["/pkg/a", { path: "/pkg/a", size: 1, mtime: runStart }],
    ]);
    const post = new Map([
      ["/pkg/a", { path: "/pkg/a", size: 2, mtime: runStart + 1 }],
      ["/pkg/b", { path: "/pkg/b", size: 3, mtime: runStart + 2 }],
    ]);
    const { rawDiff } = diffSnapshots(pre, post, runStart);
    expect(rawDiff).toContain("M\t/pkg/a");
    expect(rawDiff).toContain("A\t/pkg/b");
  });
});
