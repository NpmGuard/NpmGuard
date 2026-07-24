/**
 * GitHub panel domain store. Session is an HttpOnly same-origin cookie —
 * plain fetch carries it. Cap-shaped failures (402 {cap:true,...}) open the
 * paywall AND patch the matching billing account with fresh entitlements.
 *
 * Kept SEPARATE from auditStore — the panel is its own surface with its own
 * lifecycle. Verdicts here are PanelVerdict (4-state wire), not the audit
 * Verdict (2-state).
 */

import { create } from "zustand";
import { capBody, isReauth } from "../lib/api-base.ts";
import type {
  Alert,
  AccountEntitlements,
  BillingResponse,
  CapExceededBody,
  Installation,
  PanelRepo,
  PublicScan,
  PublicScanDetailResponse,
  RepoDetailResponse,
  SessionUser,
} from "../lib/engine-types.ts";
import * as panelApi from "../lib/panel-api.ts";

export interface RepoActionError {
  action: "audit" | "protect" | "resync";
  message: string;
}

interface PanelStoreState {
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
  repoActionErrors: Record<number, RepoActionError>;
  paywall: CapExceededBody | null;

  fetchMe: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshBilling: () => Promise<void>;
  refreshPublicScans: () => Promise<void>;
  startPublicRepoScan: (repository: string, installationId: number) => Promise<number | null>;
  fetchPublicScanDetail: (scanId: number) => Promise<PublicScanDetailResponse>;
  startProCheckout: (installationId: number) => Promise<void>;
  openBillingPortal: (installationId: number) => Promise<void>;
  triggerScan: (repoId: number) => Promise<number | null>;
  /** resolves true on success — callers needn't diff error snapshots */
  setProtect: (repoId: number, on: boolean) => Promise<boolean>;
  resync: (repoId: number) => Promise<number | null>;
  fetchRepoDetail: (owner: string, name: string) => Promise<RepoDetailResponse>;
  markAlertsSeen: () => Promise<void>;
  clearRepoActionError: (repoId: number) => void;
  closePaywall: () => void;
  clearPublicScanError: () => void;
}

function patchEntitlements(
  billing: BillingResponse | null,
  entitlements: AccountEntitlements,
): BillingResponse | null {
  if (!billing) return billing;
  return {
    ...billing,
    accounts: billing.accounts.map((account) =>
      account.installationId === entitlements.installationId ? entitlements : account,
    ),
  };
}

export const usePanelStore = create<PanelStoreState>((set, get) => {
  function handleCap(err: unknown): CapExceededBody | null {
    const cap = capBody(err);
    if (cap) {
      set({ paywall: cap, billing: patchEntitlements(get().billing, cap.entitlements) });
    }
    return cap;
  }

  function redirectToLogin() {
    window.location.href = panelApi.githubLoginUrl();
  }

  return {
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

    async fetchMe() {
      try {
        const { user } = await panelApi.fetchMe();
        set({ user, userLoaded: true });
      } catch {
        set({ user: null, userLoaded: true });
      }
    },

    async logout() {
      try {
        await panelApi.logout();
      } finally {
        set({
          user: null,
          installations: [],
          installUrl: null,
          repos: [],
          alerts: [],
          billing: null,
          publicScans: [],
          error: null,
          repoActionErrors: {},
          paywall: null,
        });
      }
    },

    async refresh() {
      set({ loading: true, error: null });
      try {
        const orgs = await panelApi.fetchOrgs();
        set({ installations: orgs.installations, installUrl: orgs.installUrl });
      } catch (err) {
        if (isReauth(err)) {
          redirectToLogin();
          return;
        }
        set({
          loading: false,
          error: err instanceof Error ? err.message : "Could not load your GitHub workspace",
        });
        return;
      }

      // Repos failure is fatal to the dashboard; billing/alerts/public scans
      // degrade gracefully.
      const [repos, alerts, billing, publicScans] = await Promise.allSettled([
        panelApi.fetchRepos(),
        panelApi.fetchAlerts(),
        panelApi.fetchBilling(),
        panelApi.fetchPublicScans(),
      ]);

      if (repos.status === "fulfilled") {
        set({ repos: repos.value.repos });
      } else if (isReauth(repos.reason)) {
        redirectToLogin();
        return;
      } else {
        set({
          loading: false,
          error:
            repos.reason instanceof Error ? repos.reason.message : "Could not load repositories",
        });
        return;
      }

      set({
        alerts: alerts.status === "fulfilled" ? alerts.value.alerts : get().alerts,
        billing: billing.status === "fulfilled" ? billing.value : get().billing,
        billingError:
          billing.status === "rejected"
            ? billing.reason instanceof Error
              ? billing.reason.message
              : "Could not load billing"
            : null,
        publicScans: publicScans.status === "fulfilled" ? publicScans.value.scans : get().publicScans,
        loading: false,
      });
    },

    async refreshBilling() {
      try {
        set({ billing: await panelApi.fetchBilling(), billingError: null });
      } catch (err) {
        set({ billingError: err instanceof Error ? err.message : "Could not load billing" });
      }
    },

    async refreshPublicScans() {
      try {
        const { scans } = await panelApi.fetchPublicScans();
        set({ publicScans: scans });
      } catch {
        // polling refresh — keep the last snapshot
      }
    },

    async startPublicRepoScan(repository, installationId) {
      set({ publicScanBusy: true, publicScanError: null });
      try {
        const { scanId } = await panelApi.startPublicRepoScan(repository, installationId);
        set({ publicScanBusy: false });
        void get().refreshPublicScans();
        void get().refreshBilling();
        return scanId;
      } catch (err) {
        set({ publicScanBusy: false });
        if (handleCap(err)) return null;
        // 409 with a scanId means "already running" — that is a success path.
        const body =
          err && typeof err === "object" && "body" in err
            ? ((err as { body?: unknown }).body as Record<string, unknown> | null)
            : null;
        if (body && typeof body["scanId"] === "number") {
          set({ publicScanBusy: false });
          void get().refreshPublicScans();
          return body["scanId"];
        }
        set({
          publicScanError:
            err instanceof Error ? err.message : "Could not start the repository audit",
        });
        return null;
      }
    },

    fetchPublicScanDetail(scanId) {
      return panelApi.fetchPublicScanDetail(scanId);
    },

    async startProCheckout(installationId) {
      set({ billingBusyInstallationId: installationId });
      try {
        const { url } = await panelApi.startProCheckout(installationId);
        window.location.assign(url);
      } catch (err) {
        set({
          billingBusyInstallationId: null,
          billingError: err instanceof Error ? err.message : "Could not start checkout",
        });
      }
    },

    async openBillingPortal(installationId) {
      set({ billingBusyInstallationId: installationId });
      try {
        const { url } = await panelApi.openBillingPortal(installationId);
        window.location.assign(url);
      } catch (err) {
        set({
          billingBusyInstallationId: null,
          billingError: err instanceof Error ? err.message : "Could not open the billing portal",
        });
      }
    },

    async triggerScan(repoId) {
      try {
        const { scanId } = await panelApi.triggerRepoScan(repoId);
        return scanId;
      } catch (err) {
        if (handleCap(err)) return null;
        set({
          repoActionErrors: {
            ...get().repoActionErrors,
            [repoId]: {
              action: "audit",
              message: err instanceof Error ? err.message : "Could not start the audit",
            },
          },
        });
        return null;
      }
    },

    async setProtect(repoId, on) {
      try {
        if (on) await panelApi.enableProtect(repoId);
        else await panelApi.disableProtect(repoId);
        set({
          repos: get().repos.map((repo) => (repo.id === repoId ? { ...repo, protected: on } : repo)),
        });
        return true;
      } catch (err) {
        if (!handleCap(err)) {
          set({
            repoActionErrors: {
              ...get().repoActionErrors,
              [repoId]: {
                action: "protect",
                message: err instanceof Error ? err.message : "Could not change protection",
              },
            },
          });
        }
        return false;
      }
    },

    async resync(repoId) {
      try {
        const { scanId } = await panelApi.resyncRepo(repoId);
        return scanId;
      } catch (err) {
        if (handleCap(err)) return null;
        set({
          repoActionErrors: {
            ...get().repoActionErrors,
            [repoId]: {
              action: "resync",
              message: err instanceof Error ? err.message : "Could not re-sync",
            },
          },
        });
        return null;
      }
    },

    fetchRepoDetail(owner, name) {
      return panelApi.fetchRepoDetail(owner, name);
    },

    async markAlertsSeen() {
      await panelApi.markAlertsSeen();
      set({ alerts: get().alerts.map((alert) => ({ ...alert, seen: true })) });
    },

    clearRepoActionError(repoId) {
      const { [repoId]: _removed, ...rest } = get().repoActionErrors;
      set({ repoActionErrors: rest });
    },

    closePaywall() {
      set({ paywall: null });
    },

    clearPublicScanError() {
      set({ publicScanError: null });
    },
  };
});
