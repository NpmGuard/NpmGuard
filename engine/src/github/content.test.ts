import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { findRootLockfile } from "./content.js";

function octokitWithRoot(entries: unknown): Octokit {
  return {
    rest: {
      repos: {
        getContent: vi.fn().mockResolvedValue({ data: entries }),
      },
    },
  } as unknown as Octokit;
}

describe("findRootLockfile", () => {
  it("detects a supported root lockfile without downloading its contents", async () => {
    const octo = octokitWithRoot([
      { type: "file", name: "README.md", path: "README.md", sha: "readme" },
      { type: "file", name: "pnpm-lock.yaml", path: "pnpm-lock.yaml", sha: "lock-sha" },
    ]);

    await expect(findRootLockfile(octo, "acme", "web", "main")).resolves.toEqual({
      path: "pnpm-lock.yaml",
      sha: "lock-sha",
    });
    expect(octo.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web",
      path: "",
      ref: "main",
    });
  });

  it("uses the same lockfile priority as repository scans", async () => {
    const octo = octokitWithRoot([
      { type: "file", name: "yarn.lock", path: "yarn.lock", sha: "yarn" },
      {
        type: "file",
        name: "package-lock.json",
        path: "package-lock.json",
        sha: "npm",
      },
    ]);

    await expect(findRootLockfile(octo, "acme", "web")).resolves.toEqual({
      path: "package-lock.json",
      sha: "npm",
    });
  });

  it("returns null for repositories without a supported root lockfile", async () => {
    const octo = octokitWithRoot([
      { type: "file", name: "package.json", path: "package.json", sha: "manifest" },
      {
        type: "dir",
        name: "frontend",
        path: "frontend",
        sha: "frontend",
      },
    ]);

    await expect(findRootLockfile(octo, "acme", "docs")).resolves.toBeNull();
  });
});
