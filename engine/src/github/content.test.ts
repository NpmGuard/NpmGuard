import type { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPublicRepoInputs,
  findRootLockfile,
  PublicRepoFileTooLargeError,
} from "./content.js";

afterEach(() => vi.unstubAllGlobals());

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

describe("fetchPublicRepoInputs", () => {
  it("uses one public root listing and downloads only GitHub raw files", async () => {
    const octo = octokitWithRoot([
      {
        type: "file",
        name: "package-lock.json",
        path: "package-lock.json",
        sha: "lock",
        download_url: "https://raw.githubusercontent.com/acme/web/main/package-lock.json",
      },
      {
        type: "file",
        name: "package.json",
        path: "package.json",
        sha: "manifest",
        download_url: "https://raw.githubusercontent.com/acme/web/main/package.json",
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"lockfileVersion":3,"packages":{}}'))
      .mockResolvedValueOnce(new Response('{"dependencies":{"x":"^1.0.0"}}'));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicRepoInputs(octo, "acme", "web", "main")).resolves.toMatchObject({
      lockfile: { path: "package-lock.json", sha: "lock" },
      manifest: { dependencies: { x: "^1.0.0" } },
    });
    expect(octo.rest.repos.getContent).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects non-GitHub raw download hosts", async () => {
    const octo = octokitWithRoot([
      {
        type: "file",
        name: "yarn.lock",
        path: "yarn.lock",
        sha: "lock",
        download_url: "https://example.com/yarn.lock",
      },
    ]);
    await expect(fetchPublicRepoInputs(octo, "acme", "web")).rejects.toThrow(
      "unsafe download URL",
    );
  });

  it("rejects oversized public lockfiles before reading their body", async () => {
    const octo = octokitWithRoot([
      {
        type: "file",
        name: "pnpm-lock.yaml",
        path: "pnpm-lock.yaml",
        sha: "lock",
        download_url: "https://raw.githubusercontent.com/acme/web/main/pnpm-lock.yaml",
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", { headers: { "content-length": String(21 * 1024 * 1024) } }),
      ),
    );
    await expect(fetchPublicRepoInputs(octo, "acme", "web")).rejects.toBeInstanceOf(
      PublicRepoFileTooLargeError,
    );
  });
});
