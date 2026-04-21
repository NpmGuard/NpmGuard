import { describe, it, expect } from "vitest";
import { applyManipulation } from "./compose.js";
import type { Manipulation } from "./types.js";

describe("applyManipulation — envs", () => {
  it("empty list yields empty spec patch + empty applied", () => {
    const composed = applyManipulation([]);
    expect(composed.specPatch.envs).toEqual({});
    expect(composed.specPatch.ldPreload).toBeNull();
    expect(composed.specPatch.preload).toBeNull();
    expect(composed.specPatch.volumes).toEqual([]);
    expect(composed.postStarts).toEqual([]);
    expect(composed.events).toEqual([]);
    expect(composed.applied.env).toEqual({});
    expect(composed.applied.plantFiles).toEqual([]);
  });

  it("merges env vars from multiple primitives, later winning", () => {
    const a: Manipulation = { envs: { CI: "true", NPM_TOKEN: "old" }, applied: { env: { CI: "true", NPM_TOKEN: "old" } } };
    const b: Manipulation = { envs: { NPM_TOKEN: "new", AWS: "xyz" }, applied: { env: { NPM_TOKEN: "new", AWS: "xyz" } } };
    const c = applyManipulation([a, b]);
    expect(c.specPatch.envs).toEqual({ CI: "true", NPM_TOKEN: "new", AWS: "xyz" });
    expect(c.applied.env).toEqual({ CI: "true", NPM_TOKEN: "new", AWS: "xyz" });
  });
});

describe("applyManipulation — last-wins scalars", () => {
  it("preload and ldPreload: last set wins", () => {
    const a: Manipulation = { ldPreload: "/a.so", preload: "/a.js", applied: {} };
    const b: Manipulation = { ldPreload: "/b.so", applied: {} };
    const c = applyManipulation([a, b]);
    expect(c.specPatch.ldPreload).toBe("/b.so");
    expect(c.specPatch.preload).toBe("/a.js"); // b didn't set it
  });

  it("hostname: last set wins", () => {
    const c = applyManipulation([
      { hostname: "dev", applied: {} },
      { hostname: "ci-runner", applied: {} },
    ]);
    expect(c.specPatch.hostname).toBe("ci-runner");
  });
});

describe("applyManipulation — volumes + capAdd", () => {
  it("volumes concatenate in order", () => {
    const c = applyManipulation([
      { volumes: [{ hostPath: "/a", containerPath: "/a", readOnly: true }], applied: {} },
      { volumes: [{ hostPath: "/b", containerPath: "/b", readOnly: false }], applied: {} },
    ]);
    expect(c.specPatch.volumes).toHaveLength(2);
    expect(c.specPatch.volumes[0]!.hostPath).toBe("/a");
    expect(c.specPatch.volumes[1]!.hostPath).toBe("/b");
  });

  it("capAdd dedupes", () => {
    const c = applyManipulation([
      { capAdd: ["SYS_PTRACE", "NET_ADMIN"], applied: {} },
      { capAdd: ["SYS_PTRACE", "SYS_ADMIN"], applied: {} },
    ]);
    expect(c.specPatch.capAdd.sort()).toEqual(["NET_ADMIN", "SYS_ADMIN", "SYS_PTRACE"]);
  });
});

describe("applyManipulation — postStart ordering + applied merging", () => {
  it("preserves postStart hook order", () => {
    const calls: string[] = [];
    const a: Manipulation = { postStart: async () => { calls.push("a"); }, applied: {} };
    const b: Manipulation = { postStart: async () => { calls.push("b"); }, applied: {} };
    const c = applyManipulation([a, b]);
    expect(c.postStarts).toHaveLength(2);
    // Don't execute here — just make sure order is preserved.
    expect(c.postStarts).toEqual([a.postStart, b.postStart]);
  });

  it("plantFiles accumulate across primitives", () => {
    const a: Manipulation = { applied: { plantFiles: [{ path: "/x", contentHash: "h1" }] } };
    const b: Manipulation = { applied: { plantFiles: [{ path: "/y", contentHash: "h2" }] } };
    const c = applyManipulation([a, b]);
    expect(c.applied.plantFiles).toHaveLength(2);
    expect(c.applied.plantFiles![0]!.path).toBe("/x");
    expect(c.applied.plantFiles![1]!.path).toBe("/y");
  });

  it("stubUrls accumulate", () => {
    const a: Manipulation = { applied: { stubUrls: [{ pattern: "*attacker*", responseHash: "r1" }] } };
    const b: Manipulation = { applied: { stubUrls: [{ pattern: "*c2*", responseHash: "r2" }] } };
    const c = applyManipulation([a, b]);
    expect(c.applied.stubUrls).toHaveLength(2);
  });

  it("patches accumulate", () => {
    const a: Manipulation = { applied: { patches: [{ path: "x.js", patchHash: "p1" }] } };
    const b: Manipulation = { applied: { patches: [{ path: "y.js", patchHash: "p2" }] } };
    const c = applyManipulation([a, b]);
    expect(c.applied.patches).toHaveLength(2);
  });

  it("date is last-wins", () => {
    const c = applyManipulation([
      { applied: { date: "2026-01-01T00:00:00Z" } },
      { applied: { date: "2027-06-15T00:00:00Z" } },
    ]);
    expect(c.applied.date).toBe("2027-06-15T00:00:00Z");
  });

  it("preloadHash is last-wins", () => {
    const c = applyManipulation([
      { applied: { preloadHash: "h1" } },
      { applied: { preloadHash: "h2" } },
    ]);
    expect(c.applied.preloadHash).toBe("h2");
  });

  it("events accumulate in declaration order", () => {
    const a: Manipulation = {
      applied: {},
      events: [{ stream: "engine", timestamp: 0, pid: 0, kind: "setup_bypass", raw: "a" }],
    };
    const b: Manipulation = {
      applied: {},
      events: [{ stream: "engine", timestamp: 0, pid: 0, kind: "setup_bypass", raw: "b" }],
    };
    const c = applyManipulation([a, b]);
    expect(c.events.map((e) => e.raw)).toEqual(["a", "b"]);
  });
});
