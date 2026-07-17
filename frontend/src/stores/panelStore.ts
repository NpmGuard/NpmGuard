import { create } from "zustand";
import type {
  Installation,
  PanelAlert,
  PanelUser,
  RepoDetailPayload,
  RepoSummary,
} from "../lib/panel-types";

const API_BASE = "/api";

// Session cookie is HttpOnly + same-origin, so plain fetch carries it.

export interface RepoActionError {
  action: "audit" | "protect";
  message: string;
}

interface PanelState {
  user: PanelUser | null;
  userLoaded: boolean;
  installations: Installation[];
  installUrl: string | null;
  repos: RepoSummary[];
  alerts: PanelAlert[];
  loading: boolean;
  /** Reserved for failures that prevent the workspace data from loading. */
  error: string | null;
  /** Action failures stay attached to their repository instead of poisoning the whole dashboard. */
  repoActionErrors: Record<number, RepoActionError>;
  /** Set when the org hit a beta cap — dashboard shows the "talk to us" wall. */
  capError: string | null;

  fetchMe: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  triggerScan: (repoId: number) => Promise<number | null>;
  setProtect: (repoId: number, on: boolean) => Promise<boolean>;
  resync: (repoId: number) => Promise<boolean>;
  fetchRepoDetail: (owner: string, name: string) => Promise<RepoDetailPayload | null>;
  markAlertsSeen: () => Promise<void>;
  clearRepoActionError: (repoId: number) => void;
}

async function jsonOrNull<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function withoutRepoActionError(
  errors: Record<number, RepoActionError>,
  repoId: number,
): Record<number, RepoActionError> {
  if (!errors[repoId]) return errors;
  const next = { ...errors };
  delete next[repoId];
  return next;
}

export const usePanelStore = create<PanelState>((set, get) => ({
  user: null,
  userLoaded: false,
  installations: [],
  installUrl: null,
  repos: [],
  alerts: [],
  loading: false,
  error: null,
  repoActionErrors: {},
  capError: null,

  fetchMe: async () => {
    try {
      const res = await fetch(`${API_BASE}/me`);
      if (res.ok) {
        const data = await jsonOrNull<{ user: PanelUser }>(res);
        set({ user: data?.user ?? null, userLoaded: true });
      } else {
        set({ user: null, userLoaded: true });
      }
    } catch {
      set({ user: null, userLoaded: true });
    }
  },

  logout: async () => {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST" });
    set({
      user: null,
      installations: [],
      repos: [],
      alerts: [],
      error: null,
      repoActionErrors: {},
      capError: null,
    });
  },

  refresh: async () => {
    set({ loading: true, error: null, repoActionErrors: {} });
    try {
      const orgsRes = await fetch(`${API_BASE}/panel/orgs`);
      if (!orgsRes.ok) {
        const data = await jsonOrNull<{ error?: string; reauth?: boolean }>(orgsRes);
        if (orgsRes.status === 401 && data?.reauth) {
          // GitHub token expired — a fresh OAuth round-trip fixes it
          window.location.href = `${API_BASE}/auth/github/login`;
          return;
        }
        set({ loading: false, error: data?.error ?? `Failed to load orgs (${orgsRes.status})` });
        return;
      }
      const orgs = await orgsRes.json();
      set({ installations: orgs.installations, installUrl: orgs.installUrl });

      const [reposRes, alertsRes] = await Promise.all([
        fetch(`${API_BASE}/panel/repos`),
        fetch(`${API_BASE}/panel/alerts`),
      ]);

      const reposData = await jsonOrNull<{ repos?: RepoSummary[]; error?: string }>(reposRes);
      if (!reposRes.ok || !reposData?.repos) {
        set({
          loading: false,
          error:
            reposData?.error ??
            `Failed to load repositories (${reposRes.status})`,
        });
        return;
      }

      const alertsData = await jsonOrNull<{ alerts?: PanelAlert[] }>(alertsRes);
      const repos = reposData.repos;
      const alerts = alertsRes.ok ? (alertsData?.alerts ?? []) : [];
      set({ repos, alerts, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Network error" });
    }
  },

  triggerScan: async (repoId) => {
    set((state) => ({
      capError: null,
      repoActionErrors: withoutRepoActionError(state.repoActionErrors, repoId),
    }));
    try {
      const res = await fetch(`${API_BASE}/panel/repo/${repoId}/scan`, { method: "POST" });
      const data = await jsonOrNull<{ scanId?: number; error?: string; cap?: boolean }>(res);
      if (res.ok && data?.scanId) return data.scanId;
      if (data?.cap) {
        set({ capError: data.error ?? "Beta limit reached" });
      } else {
        set((state) => ({
          repoActionErrors: {
            ...state.repoActionErrors,
            [repoId]: {
              action: "audit",
              message: data?.error ?? `Scan failed to start (${res.status})`,
            },
          },
        }));
      }
    } catch (err) {
      set((state) => ({
        repoActionErrors: {
          ...state.repoActionErrors,
          [repoId]: {
            action: "audit",
            message: err instanceof Error ? err.message : "Network error while starting the audit",
          },
        },
      }));
    }
    return null;
  },

  setProtect: async (repoId, on) => {
    set((state) => ({
      capError: null,
      repoActionErrors: withoutRepoActionError(state.repoActionErrors, repoId),
    }));
    try {
      const res = await fetch(`${API_BASE}/panel/repo/${repoId}/protect`, {
        method: on ? "POST" : "DELETE",
      });
      const data = await jsonOrNull<{ error?: string; cap?: boolean }>(res);
      if (res.ok) {
        set((state) => ({
          repos: state.repos.map((repo) => (repo.id === repoId ? { ...repo, protected: on } : repo)),
        }));
        return true;
      }
      if (data?.cap) {
        set({ capError: data.error ?? "Beta limit reached" });
      } else {
        set((state) => ({
          repoActionErrors: {
            ...state.repoActionErrors,
            [repoId]: {
              action: "protect",
              message: data?.error ?? `Protect toggle failed (${res.status})`,
            },
          },
        }));
      }
    } catch (err) {
      set((state) => ({
        repoActionErrors: {
          ...state.repoActionErrors,
          [repoId]: {
            action: "protect",
            message: err instanceof Error ? err.message : "Network error while updating protection",
          },
        },
      }));
    }
    return false;
  },

  resync: async (repoId) => {
    const res = await fetch(`${API_BASE}/panel/repo/${repoId}/resync`, { method: "POST" });
    return res.ok;
  },

  fetchRepoDetail: async (owner, name) => {
    const res = await fetch(
      `${API_BASE}/panel/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as RepoDetailPayload;
  },

  markAlertsSeen: async () => {
    await fetch(`${API_BASE}/panel/alerts/seen`, { method: "POST" });
    set({ alerts: get().alerts.map((a) => ({ ...a, seen: true })) });
  },

  clearRepoActionError: (repoId) => {
    set((state) => ({
      repoActionErrors: withoutRepoActionError(state.repoActionErrors, repoId),
    }));
  },
}));
