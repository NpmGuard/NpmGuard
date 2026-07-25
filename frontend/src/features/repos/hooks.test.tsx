/**
 * Unit: the repos query module — features/repos/{api,keys,hooks}.
 *
 * Driven through msw against the REAL api layer, so the schema parse at the
 * boundary is in the loop. Handlers are origin-relative; `apiBase()` is pinned
 * absolute for undici (see lib/test-harness.tsx).
 *
 * Input classes:
 *  R2  contract violation      — a response that does not match `ReposResponse` ends
 *                                the read as FAILED at the boundary. It never arrives
 *                                in a component as a half-built repo, and it is not
 *                                retried, because the same payload fails the same way.
 *  R3  empty ≠ failed          — `{repos: []}` is a successful read of nothing and
 *                                carries the read token; a 502 is a failure with no
 *                                data at all. The two are not interchangeable in
 *                                either direction.
 *  R4  409 is a success        — "a scan is already running" returns the in-flight
 *                                `scanId` rather than an error, parsed from the named
 *                                `ScanAlreadyRunning` body instead of sniffed.
 *  R5  protect patches, not refetches — a successful protect flips the flag in the
 *                                cached repo list without re-paginating GitHub, and a
 *                                FAILED protect flips nothing.
 *
 * Blackbox: hooks are exercised through a probe component; assertions read the
 * returned `LoadState` and the query cache.
 */

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { useEffect } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadState } from "../../components/ui/load-state.ts";
import {
  clearAbsoluteApiBase,
  makeTestClient,
  panelRepo,
  SESSION_USER,
  useAbsoluteApiBase,
} from "../../lib/test-harness.tsx";
import { sessionKeys } from "../session/keys.ts";
import { repoKeys } from "./keys.ts";
import { useRepos, useSetProtect, useStartPublicScan } from "./hooks.ts";

const server = setupServer();

beforeAll(() => {
  useAbsoluteApiBase();
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  clearAbsoluteApiBase();
});

let client: QueryClient;

/** A signed-in session, seeded straight into the cache: every panel read is
 * `enabled` on it, and these tests are not about the session. */
function signedIn(): QueryClient {
  const next = makeTestClient();
  next.setQueryData(sessionKeys.me(), { user: SESSION_USER, appEnabled: true });
  return next;
}

beforeEach(() => {
  client = signedIn();
});

function withClient(ui: React.ReactNode) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Records every state the hook returns. `sink` is a stable array rather than a
 * callback so the effect has no changing identity of its own. */
function ReposProbe({ sink }: { sink: LoadState<unknown>[] }) {
  const state = useRepos();
  useEffect(() => {
    sink.push(state);
  }, [state, sink]);
  return null;
}

describe("repos — R2 a response that violates the contract fails at the boundary", () => {
  it("R2: a repo missing `defaultBranch` is a FAILED read, not a half-built repo", async () => {
    const { defaultBranch: _dropped, ...broken } = panelRepo();
    server.use(http.get("/api/panel/repos", () => HttpResponse.json({ repos: [broken] })));

    const seen: LoadState<unknown>[] = [];
    withClient(<ReposProbe sink={seen} />);

    await waitFor(() => expect(seen.at(-1)?.status).toBe("failed"));
    const state = seen.at(-1)!;
    if (state.status !== "failed") throw new Error("unreachable");
    // Named as drift, not as "not found": the reader is sent to whoever changed
    // the engine, not to GitHub permissions.
    expect(state.failure.detail).toContain("does not match the contract");
    expect(state.failure.detail).toContain("defaultBranch");
    // Retrying cannot change a deterministic parse, so no dead button is offered.
    expect(state.failure.retry).toBeUndefined();
    // And nothing reached the cache to be rendered.
    expect(client.getQueryData(repoKeys.list())).toBeUndefined();
  });
});

describe("repos — R3 an empty read and a failed read are not interchangeable", () => {
  it("R3: `{repos: []}` is ok-and-empty, carrying the read-succeeded token", async () => {
    server.use(http.get("/api/panel/repos", () => HttpResponse.json({ repos: [] })));
    const seen: LoadState<unknown>[] = [];
    withClient(<ReposProbe sink={seen} />);
    await waitFor(() => expect(seen.at(-1)?.status).toBe("ok"));
    const state = seen.at(-1)!;
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.data).toEqual([]);
    // The token EmptyState requires. A failed read cannot produce one.
    expect(state.read).toBeDefined();
  });

  it("R3: a 502 is failed with no data — the empty state is unreachable from here", async () => {
    server.use(
      http.get("/api/panel/repos", () => HttpResponse.json({ error: "upstream" }, { status: 502 })),
    );
    const seen: LoadState<unknown>[] = [];
    withClient(<ReposProbe sink={seen} />);
    await waitFor(() => expect(seen.at(-1)?.status).toBe("failed"));
    const state = seen.at(-1)!;
    expect(state).not.toHaveProperty("data");
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.failure.what).toBe("Repositories");
  });
});

function PublicScanProbe({ onDone }: { onDone: (scanId: number) => void }) {
  const scan = useStartPublicScan();
  useEffect(() => {
    scan.mutate(
      { repository: "acme/widget", installationId: 1 },
      { onSuccess: ({ scanId }) => void onDone(scanId) },
    );
    // mount only — one submission per probe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe("repos — R4 409 already-running is a success path", () => {
  it("R4: the in-flight scanId is returned from the named 409 body", async () => {
    server.use(
      http.post("/api/panel/public-repos/scan", () =>
        HttpResponse.json({ error: "A scan is already running", scanId: 77 }, { status: 409 }),
      ),
      http.get("/api/panel/public-repos", () => HttpResponse.json({ scans: [] })),
      http.get("/api/panel/billing", () => HttpResponse.json({ error: "unused" }, { status: 500 })),
    );
    const onDone = vi.fn();
    withClient(<PublicScanProbe onDone={onDone} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(77));
  });

  it("R4: a 409 that is NOT the named body stays a failure — the sniff is gone", async () => {
    server.use(
      http.post("/api/panel/public-repos/scan", () =>
        // No `scanId`: this is a genuine conflict, and treating it as success
        // would stream a set that does not exist.
        HttpResponse.json({ error: "conflict" }, { status: 409 }),
      ),
    );
    const onDone = vi.fn();
    withClient(<PublicScanProbe onDone={onDone} />);
    await waitFor(() => expect(onDone).not.toHaveBeenCalled());
  });
});

function ProtectProbe({ repoId, onSettled }: { repoId: number; onSettled: () => void }) {
  const setProtect = useSetProtect();
  useEffect(() => {
    setProtect.mutate({ repoId, on: true }, { onSettled });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe("repos — R5 protect patches the cache, and only on success", () => {
  it("R5: a successful protect flips the cached flag without refetching /panel/repos", async () => {
    const listHits = vi.fn();
    server.use(
      http.get("/api/panel/repos", () => {
        listHits();
        return HttpResponse.json({ repos: [panelRepo({ id: 5, protected: false })] });
      }),
      http.post("/api/panel/repo/5/protect", () => HttpResponse.json({ ok: true })),
    );
    client.setQueryData(repoKeys.list(), { repos: [panelRepo({ id: 5, protected: false })] });

    const settled = vi.fn();
    withClient(<ProtectProbe repoId={5} onSettled={settled} />);
    await waitFor(() => expect(settled).toHaveBeenCalled());

    await waitFor(() =>
      expect(
        client.getQueryData<{ repos: { protected: boolean }[] }>(repoKeys.list())?.repos[0]
          ?.protected,
      ).toBe(true),
    );
    // The expensive list was never re-paginated to learn one boolean.
    expect(listHits).not.toHaveBeenCalled();
  });

  it("R5: a failed protect flips nothing — no optimistic protection is ever shown", async () => {
    server.use(
      http.post("/api/panel/repo/5/protect", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    client.setQueryData(repoKeys.list(), { repos: [panelRepo({ id: 5, protected: false })] });

    const settled = vi.fn();
    withClient(<ProtectProbe repoId={5} onSettled={settled} />);
    await waitFor(() => expect(settled).toHaveBeenCalled());

    expect(
      client.getQueryData<{ repos: { protected: boolean }[] }>(repoKeys.list())?.repos[0]?.protected,
    ).toBe(false);
  });
});
