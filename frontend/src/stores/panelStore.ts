/**
 * Panel UI state — and NOTHING that came from the server.
 *
 * This store owns none of: server fetching, response caching, staleness, polling,
 * error policy, or optimistic updates. Owning those alongside UI state means
 * hand-rolling a cache layer — a `refresh()` with an N-way `Promise.allSettled`
 * and per-branch fallbacks. All of it lives in `@tanstack/react-query`; see each
 * feature's `hooks.ts`. **Server state is not application state.**
 *
 * What is left is the one UI fact that genuinely outlives a single component
 * tree: an open paywall. It is opened by a mutation that 402'd (globally, in
 * `lib/query-client.ts`) and consumed by a dialog rendered from two different
 * pages, so neither end owns it.
 *
 * The bar for adding a field here: it must be UI state (not a server read), and
 * it must be needed by two components that are not each other's ancestor.
 * Things that did NOT clear that bar and must not come back:
 *
 *  - `repos` / `alerts` / `billing` / `publicScans` / `user` / `installations`
 *    — server reads. The query cache owns them, and its per-query status is the
 *    whole point: a partial fetch can no longer render as a confident view.
 *  - `loading` / `error` / `billingError` — one hand-maintained status field per
 *    resource. `useQuery` has one per query, for free, and they cannot drift.
 *  - `repoActionErrors: Record<number, …>` — a map keyed by repo id is only
 *    needed because a global store has nowhere else to put the error. It belongs
 *    to the mutation that failed, and `useMutation` is instantiated per row, so
 *    the row already has its own error and its own `reset()`.
 *  - `billingBusyInstallationId` — "which row is busy" IS legitimate UI state,
 *    but react-query already answers it per row with
 *    `isPending && variables === installationId`. A store field would be a
 *    second copy of a fact the mutation already holds.
 */

import type { CapExceeded } from "@npmguard/shared";
import { create } from "zustand";

interface PanelUiState {
  /** The 402 body, which carries FRESH entitlements — so the exhausted meter
   * renders from the very response that opened the dialog, with no refetch. */
  paywall: CapExceeded | null;
  openPaywall: (cap: CapExceeded) => void;
  closePaywall: () => void;
}

export const usePanelUi = create<PanelUiState>((set) => ({
  paywall: null,
  openPaywall: (cap) => set({ paywall: cap }),
  closePaywall: () => set({ paywall: null }),
}));
