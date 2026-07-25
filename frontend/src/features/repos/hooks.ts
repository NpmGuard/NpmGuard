/**
 * Repository + audit-set reads and mutations.
 *
 * Two things here are worth reading before changing anything:
 *
 * 1. **The progress stream is a WRITER into the query cache**, not a second
 *    store. `useRepoDetail` and the stream both describe one fact ("the deps of
 *    this set"), and the moment they live in two places they can disagree — which
 *    is what a component-local `useState` mirror of a fetched response always
 *    eventually does. So frames go through `setQueryData` and the query cache
 *    stays the single source of truth.
 * 2. **`/panel/repos` is patched, not invalidated, after a mutation.** It
 *    paginates live GitHub and probes every repo for a lockfile, so invalidating
 *    it to learn one boolean would be a very expensive way to find out something
 *    the response already told us.
 */

import type {
  AuditSetItem,
  PanelRepo,
  PublicRepoScan,
  PublicRepoScanDetailResponse,
  RepoDetailResponse,
  ReposResponse,
  ScanStreamFrame,
} from "@npmguard/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { LoadState } from "../../components/ui/load-state.ts";
import { toLoadState } from "../../lib/query-state.ts";
import { connectScanStream } from "../../lib/sse.ts";
import { billingKeys } from "../billing/keys.ts";
import { useSignedIn } from "../session/hooks.ts";
import {
  disableProtect,
  enableProtect,
  fetchPublicScanDetail,
  fetchPublicScans,
  fetchRepoDetail,
  fetchRepos,
  resyncRepo,
  scanEventsUrl,
  startPublicRepoScan,
  triggerRepoScan,
} from "./api.ts";
import { repoKeys } from "./keys.ts";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function useRepos(): LoadState<PanelRepo[]> {
  const signedIn = useSignedIn();
  const query = useQuery({
    queryKey: repoKeys.list(),
    queryFn: fetchRepos,
    enabled: signedIn,
    // Live GitHub pagination + a lockfile probe per repo. Long freshness is not
    // laziness: the set of repositories a person can audit changes when they
    // install the App, and that is a full-page return from github.com.
    staleTime: 2 * 60_000,
    select: (response: ReposResponse) => response.repos,
  });
  return toLoadState(query, "Repositories");
}

export function useRepoDetail(owner: string, name: string): LoadState<RepoDetailResponse> {
  const query = useQuery({
    queryKey: repoKeys.detail(owner, name),
    queryFn: () => fetchRepoDetail(owner, name),
    enabled: owner.length > 0 && name.length > 0,
  });
  return toLoadState(query, `${owner}/${name}`);
}

export function usePublicScans(): LoadState<PublicRepoScan[]> {
  const signedIn = useSignedIn();
  const query = useQuery({
    queryKey: repoKeys.publicScans(),
    queryFn: fetchPublicScans,
    enabled: signedIn,
    // The LIST polls while any snapshot is live, because the per-set stream
    // advances ONE set and this view is a list of many. Expressed as a
    // data-dependent interval, so it starts and stops itself — the old page held
    // a `setInterval` in an effect keyed on a derived boolean.
    refetchInterval: (query) =>
      query.state.data?.scans.some((scan) => scan.set.status === "running") ? 2500 : false,
    select: (response) => response.scans,
  });
  return toLoadState(query, "Public repository audits");
}

export function usePublicScanDetail(scanId: number): LoadState<PublicRepoScanDetailResponse> {
  const query = useQuery({
    queryKey: repoKeys.publicScan(scanId),
    queryFn: () => fetchPublicScanDetail(scanId),
  });
  return toLoadState(query, `Snapshot #${scanId}`);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useTriggerScan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: triggerRepoScan,
    // The list and the detail both carry the set that just started, and neither
    // can derive it from the `{scanId}` response — so this is the one place a
    // refetch is the cheap answer rather than the expensive one.
    onSuccess: () => void client.invalidateQueries({ queryKey: repoKeys.all }),
  });
}

export function useResync() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: resyncRepo,
    onSuccess: () => void client.invalidateQueries({ queryKey: repoKeys.all }),
  });
}

export function useSetProtect() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, on }: { repoId: number; on: boolean }) =>
      on ? enableProtect(repoId) : disableProtect(repoId),
    // Patched on SUCCESS, not optimistically on mutate. Protect can be refused
    // (402 cap), and an optimistic flip would show the repo as protected for the
    // instant before the paywall opens — a security product must not flash a
    // protection state it does not have.
    onSuccess: (_data, { repoId, on }) => {
      client.setQueryData<ReposResponse>(repoKeys.list(), (list) =>
        list
          ? {
              repos: list.repos.map((repo) =>
                repo.id === repoId ? { ...repo, protected: on } : repo,
              ),
            }
          : list,
      );
      // The detail page holds its own copy of the repo row, keyed by
      // owner/name rather than id, so it is patched by predicate.
      client.setQueriesData<RepoDetailResponse>({ queryKey: repoKeys.details() }, (detail) =>
        detail && detail.repo.id === repoId
          ? { ...detail, repo: { ...detail.repo, protected: on } }
          : detail,
      );
    },
  });
}

export function useStartPublicScan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: startPublicRepoScan,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: repoKeys.publicScans() });
      // A public audit spends a repository allowance, so the ledger it is spent
      // from is now stale.
      void client.invalidateQueries({ queryKey: billingKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Progress stream → query cache
// ---------------------------------------------------------------------------

/** Every frame EXCEPT the terminal one. `done` carries no subject, so a writer
 * that had to accept it would need a branch it can never use — `useScanStream`
 * handles it and this type is what stops it leaking further. */
type ScanUpdateFrame = Exclude<ScanStreamFrame, { type: "done" }>;

/** Replace one item by (name, version). A `dep` frame carries the WHOLE contract
 * item, so this is a replacement and not a merge — which is what makes replaying
 * a frame after a `Last-Event-ID` reconnect idempotent with no seq guard. */
function replaceItem(deps: AuditSetItem[], item: AuditSetItem): AuditSetItem[] {
  return deps.map((dep) => (dep.name === item.name && dep.version === item.version ? item : dep));
}

/**
 * Follow ONE audit set. `null` means there is nothing live to follow.
 *
 * The handlers are read through a ref so the effect depends on the SET ID alone:
 * they close over `queryClient` and a freshly-built key array, both of which
 * change identity every render, and keying the effect on them would tear down
 * and reopen the EventSource on every render — a reconnect storm that looks like
 * a flaky engine.
 */
function useScanStream(
  setId: number | null,
  handlers: { onFrame: (frame: ScanUpdateFrame) => void; onEnd: () => void },
): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (setId === null) return;
    const handle = connectScanStream(scanEventsUrl(setId), {
      onMessage(frame) {
        // The terminal frame and a transport error take the SAME recovery: refetch
        // the authoritative response. That is also what picks up items the capped
        // detail projection never carried.
        if (frame.type === "done") {
          handle.close();
          latest.current.onEnd();
          return;
        }
        latest.current.onFrame(frame);
      },
      onError: () => latest.current.onEnd(),
    });
    return () => handle.close();
  }, [setId]);
}

/** Live progress for a repo's running scan, written into its detail entry. */
export function useRepoDetailStream(owner: string, name: string, setId: number | null): void {
  const client = useQueryClient();
  const queryKey = repoKeys.detail(owner, name);
  useScanStream(setId, {
    onFrame: (frame) =>
      client.setQueryData<RepoDetailResponse>(queryKey, (detail) => {
        if (!detail) return detail;
        if (frame.type === "dep") return { ...detail, deps: replaceItem(detail.deps, frame.item) };
        if (!detail.set) return detail;
        return { ...detail, set: { ...detail.set, status: frame.status, rollup: frame.rollup } };
      }),
    onEnd: () => void client.invalidateQueries({ queryKey }),
  });
}

/** Live progress for a public snapshot, written into its detail entry. Same
 * stream, same frames — only the envelope the set lives in differs. */
export function usePublicScanStream(scanId: number, running: boolean): void {
  const client = useQueryClient();
  const queryKey = repoKeys.publicScan(scanId);
  useScanStream(running ? scanId : null, {
    onFrame: (frame) =>
      client.setQueryData<PublicRepoScanDetailResponse>(queryKey, (detail) => {
        if (!detail) return detail;
        if (frame.type === "dep") return { ...detail, deps: replaceItem(detail.deps, frame.item) };
        return {
          ...detail,
          scan: {
            ...detail.scan,
            set: { ...detail.scan.set, status: frame.status, rollup: frame.rollup },
          },
        };
      }),
    onEnd: () => void client.invalidateQueries({ queryKey }),
  });
}
