/**
 * Render helpers for panel component-integration tests.
 *
 * - `renderRoute` mounts a component inside a real react-router MemoryRouter so
 *   `useParams`/`useNavigate`/`<Link>` behave exactly as in the app. Pass a
 *   `path` pattern + `entries` to drive `useParams` (e.g. RepoDetail).
 * - `resetPanelStore` wipes the module-singleton zustand store between tests so
 *   they share no mutable state (a TESTING.md determinism rule). Actions are
 *   preserved — only the data slots reset (optionally pre-seeded).
 * - `installMockEventSource` supplies the `EventSource` global (absent in jsdom)
 *   so `connectScanStream` can be driven deterministically from a test.
 */

import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { usePanelStore } from "../stores/panelStore.ts";
import type { PanelData } from "./panel-server.ts";
import type {
  Alert,
  BillingResponse,
  Installation,
  PanelRepo,
  PublicScan,
  SessionUser,
} from "../lib/engine-types.ts";

export interface RenderRouteOptions {
  /** Initial URL(s) in history (default `["/"]`). */
  entries?: string[];
  /** A route pattern (e.g. `/repo/:owner/:name`) so `useParams` resolves. When
   *  omitted the element is mounted at `*`. */
  path?: string;
}

export function renderRoute(ui: ReactElement, options: RenderRouteOptions = {}): RenderResult {
  const { entries = ["/"], path } = options;
  return render(
    <MemoryRouter initialEntries={entries}>
      <Routes>
        <Route path={path ?? "*"} element={ui} />
        {/* Sink routes so navigate()/<Link> targets resolve without warnings. */}
        <Route path="/dashboard" element={<div data-testid="route-dashboard" />} />
        <Route path="/repo/:owner/:name" element={<div data-testid="route-repo-detail" />} />
        <Route path="/package/*" element={<div data-testid="route-package" />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The panel store's data slots (actions are left intact by a merge set). */
interface PanelDataState {
  user: SessionUser | null;
  userLoaded: boolean;
  installations: Installation[];
  installUrl: string | null;
  repos: PanelRepo[];
  alerts: Alert[];
  billing: BillingResponse | null;
  billingError: string | null;
  billingBusyInstallationId: number | null;
  publicScans: PublicScan[];
  publicScanBusy: boolean;
  publicScanError: string | null;
  loading: boolean;
  error: string | null;
  repoActionErrors: Record<number, unknown>;
  paywall: unknown;
}

const INITIAL: PanelDataState = {
  user: null,
  userLoaded: false,
  installations: [],
  installUrl: null,
  repos: [],
  alerts: [],
  billing: null,
  billingError: null,
  billingBusyInstallationId: null,
  publicScans: [],
  publicScanBusy: false,
  publicScanError: null,
  loading: false,
  error: null,
  repoActionErrors: {},
  paywall: null,
};

/** Reset the singleton panel store to its empty state, then apply `seed`
 * (e.g. `{ user: makeUser(), userLoaded: true }` to skip the login gate). */
export function resetPanelStore(seed: Partial<PanelDataState> = {}): void {
  usePanelStore.setState({ ...INITIAL, ...seed }, false);
}

/** Convenience: seed an authenticated session (past the login gate). */
export function authedSeed(seed: Partial<PanelDataState> = {}): Partial<PanelDataState> {
  return { user: { id: 1, login: "octocat", name: null, email: null, avatarUrl: null }, userLoaded: true, ...seed };
}

// ── Mock EventSource (jsdom has none) ───────────────────────────────────────

export interface MockEventSourceInstance {
  url: string;
  readyState: number;
  closed: boolean;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  /** Push a default (unnamed) SSE message — the panel scan stream shape. */
  emit(data: unknown): void;
  /** Trip the error handler. */
  fail(): void;
  close(): void;
  addEventListener(): void;
  removeEventListener(): void;
}

class MockEventSource implements MockEventSourceInstance {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 1;
  closed = false;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  emitRaw(data: string): void {
    this.onmessage?.({ data });
  }
  fail(): void {
    this.onerror?.(new Event("error"));
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** Install a controllable `EventSource` on the global for the duration of a
 * test. Returns a handle exposing the constructed instances + a restore fn.
 * The latest instance is `handle.last()`. */
export function installMockEventSource(): {
  instances: MockEventSource[];
  last(): MockEventSource | undefined;
  restore(): void;
} {
  const prior = (globalThis as { EventSource?: unknown }).EventSource;
  MockEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = MockEventSource as unknown;
  return {
    instances: MockEventSource.instances,
    last: () => MockEventSource.instances[MockEventSource.instances.length - 1],
    restore: () => {
      (globalThis as { EventSource?: unknown }).EventSource = prior;
    },
  };
}
