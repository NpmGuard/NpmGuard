import { create } from "zustand";
import type {
  BillingPayload,
  Installation,
  PanelAlert,
  PanelUser,
  PaywallReason,
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
  billing: BillingPayload | null;
  billingBusyInstallationId: number | null;
  billingError: string | null;
  loading: boolean;
  /** Reserved for failures that prevent the workspace data from loading. */
  error: string | null;
  /** Action failures stay attached to their repository instead of poisoning the whole dashboard. */
  repoActionErrors: Record<number, RepoActionError>;
  /** Set when an account reaches an allowance and should see the upgrade dialog. */
  paywall: PaywallReason | null;

  fetchMe: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshBilling: () => Promise<void>;
  startProCheckout: (installationId: number) => Promise<boolean>;
  openBillingPortal: (installationId: number) => Promise<boolean>;
  triggerScan: (repoId: number) => Promise<number | null>;
  setProtect: (repoId: number, on: boolean) => Promise<boolean>;
  resync: (repoId: number) => Promise<boolean>;
  fetchRepoDetail: (owner: string, name: string) => Promise<RepoDetailPayload | null>;
  markAlertsSeen: () => Promise<void>;
  clearRepoActionError: (repoId: number) => void;
  closePaywall: () => void;
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
  billing: null,
  billingBusyInstallationId: null,
  billingError: null,
  loading: false,
  error: null,
  repoActionErrors: {},
  paywall: null,

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
      billing: null,
      billingBusyInstallationId: null,
      billingError: null,
      error: null,
      repoActionErrors: {},
      paywall: null,
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

      const [reposRes, alertsRes, billingRes] = await Promise.all([
        fetch(`${API_BASE}/panel/repos`),
        fetch(`${API_BASE}/panel/alerts`),
        fetch(`${API_BASE}/panel/billing`),
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
      const billingData = await jsonOrNull<BillingPayload>(billingRes);
      const repos = reposData.repos;
      const alerts = alertsRes.ok ? (alertsData?.alerts ?? []) : [];
      set({
        repos,
        alerts,
        billing: billingRes.ok ? billingData : null,
        billingError: billingRes.ok ? null : "Plan usage could not be refreshed",
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Network error" });
    }
  },

  refreshBilling: async () => {
    try {
      const res = await fetch(`${API_BASE}/panel/billing`);
      const data = await jsonOrNull<BillingPayload>(res);
      if (!res.ok || !data) {
        set({ billingError: "Plan usage could not be refreshed" });
        return;
      }
      set({ billing: data, billingError: null });
    } catch {
      set({ billingError: "Plan usage could not be refreshed" });
    }
  },

  startProCheckout: async (installationId) => {
    set({ billingBusyInstallationId: installationId, billingError: null });
    try {
      const res = await fetch(`${API_BASE}/panel/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
      });
      const data = await jsonOrNull<{ url?: string; error?: string }>(res);
      if (!res.ok || !data?.url) {
        set({
          billingBusyInstallationId: null,
          billingError: data?.error ?? "Unable to start checkout",
        });
        return false;
      }
      window.location.assign(data.url);
      return true;
    } catch {
      set({ billingBusyInstallationId: null, billingError: "Unable to start checkout" });
      return false;
    }
  },

  openBillingPortal: async (installationId) => {
    set({ billingBusyInstallationId: installationId, billingError: null });
    try {
      const res = await fetch(`${API_BASE}/panel/billing/portal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
      });
      const data = await jsonOrNull<{ url?: string; error?: string }>(res);
      if (!res.ok || !data?.url) {
        set({
          billingBusyInstallationId: null,
          billingError: data?.error ?? "Unable to open billing",
        });
        return false;
      }
      window.location.assign(data.url);
      return true;
    } catch {
      set({ billingBusyInstallationId: null, billingError: "Unable to open billing" });
      return false;
    }
  },

  triggerScan: async (repoId) => {
    set((state) => ({
      paywall: null,
      repoActionErrors: withoutRepoActionError(state.repoActionErrors, repoId),
    }));
    try {
      const res = await fetch(`${API_BASE}/panel/repo/${repoId}/scan`, { method: "POST" });
      const data = await jsonOrNull<{
        scanId?: number;
        error?: string;
        cap?: boolean;
        resource?: PaywallReason["resource"];
        installationId?: number;
        entitlements?: PaywallReason["entitlements"];
      }>(res);
      if (res.ok && data?.scanId) {
        void get().refreshBilling();
        return data.scanId;
      }
      if (data?.cap && data.resource && data.installationId && data.entitlements) {
        set((state) => ({
          paywall: {
            message: data.error ?? "Free allowance reached",
            resource: data.resource!,
            installationId: data.installationId!,
            entitlements: data.entitlements!,
          },
          billing: state.billing
            ? {
                ...state.billing,
                accounts: state.billing.accounts.map((account) =>
                  account.installationId === data.installationId ? data.entitlements! : account,
                ),
              }
            : state.billing,
        }));
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
      paywall: null,
      repoActionErrors: withoutRepoActionError(state.repoActionErrors, repoId),
    }));
    try {
      const res = await fetch(`${API_BASE}/panel/repo/${repoId}/protect`, {
        method: on ? "POST" : "DELETE",
      });
      const data = await jsonOrNull<{
        error?: string;
        cap?: boolean;
        resource?: PaywallReason["resource"];
        installationId?: number;
        entitlements?: PaywallReason["entitlements"];
      }>(res);
      if (res.ok) {
        set((state) => ({
          repos: state.repos.map((repo) => (repo.id === repoId ? { ...repo, protected: on } : repo)),
        }));
        void get().refreshBilling();
        return true;
      }
      if (data?.cap && data.resource && data.installationId && data.entitlements) {
        set({
          paywall: {
            message: data.error ?? "Free allowance reached",
            resource: data.resource,
            installationId: data.installationId,
            entitlements: data.entitlements,
          },
        });
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
    if (res.ok) {
      void get().refreshBilling();
      return true;
    }
    const data = await jsonOrNull<{
      error?: string;
      cap?: boolean;
      resource?: PaywallReason["resource"];
      installationId?: number;
      entitlements?: PaywallReason["entitlements"];
    }>(res);
    if (data?.cap && data.resource && data.installationId && data.entitlements) {
      set({
        paywall: {
          message: data.error ?? "Free allowance reached",
          resource: data.resource,
          installationId: data.installationId,
          entitlements: data.entitlements,
        },
      });
    }
    return false;
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

  closePaywall: () => set({ paywall: null }),
}));
