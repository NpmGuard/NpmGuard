/** Repository card for the dashboard grid. Accent bar follows the last
 * scan's tone; action errors render inline and dismissible so a single failure
 * never poisons the whole dashboard.
 *
 * Both mutations are instantiated PER CARD, which is what deleted the store's
 * `repoActionErrors: Record<number, RepoActionError>`. That map existed only
 * because the actions lived in one global object and their failures therefore
 * needed a key to tell them apart; here the failing mutation and the row that
 * owns it are the same object, and `reset()` is the dismiss. */

import type { PanelRepo } from "@npmguard/shared";
import { ArrowRight, Shield, ShieldCheck, X } from "lucide-react";
import { type CSSProperties } from "react";
import { useNavigate } from "react-router";
import { scanTone, toneAccent } from "../../../components/panel/tone.tsx";
import { actionFailure } from "../../../lib/query-state.ts";
import { useSetProtect, useTriggerScan } from "../hooks.ts";
import { ScanStatus } from "./ScanStatus.tsx";

export function RepoCard({ repo }: { repo: PanelRepo }) {
  const navigate = useNavigate();
  const triggerScan = useTriggerScan();
  const setProtect = useSetProtect();

  const running = repo.lastScan?.status === "running";
  const detailPath = `/repo/${repo.owner}/${repo.name}`;

  // A cap is not shown here — the paywall dialog owns it, and rendering both
  // would read as two separate problems.
  const failure =
    actionFailure(triggerScan.error, "Starting the audit") ??
    actionFailure(setProtect.error, "Changing protection");
  const dismiss = () => {
    triggerScan.reset();
    setProtect.reset();
  };

  const runAudit = () => {
    triggerScan.mutate(repo.id, { onSuccess: () => navigate(detailPath) });
  };

  return (
    <article
      className="card card--accent panel-repo fade-up"
      style={{ "--accent": toneAccent(scanTone(repo.lastScan)) } as CSSProperties}
    >
      <header className="panel-repo__head">
        <button
          type="button"
          className="panel-repo__id"
          onClick={() => navigate(detailPath)}
          aria-label={`Open ${repo.fullName}`}
        >
          <span className="microtext">{repo.owner}</span>
          <span className="panel-repo__name">{repo.name}</span>
        </button>
        <div className="panel-repo__tags">
          {repo.private && <span className="tag">Private</span>}
          {repo.protected && <span className="tag tag--violet">Protected</span>}
        </div>
      </header>

      <ScanStatus scan={repo.lastScan} />

      {failure && (
        <div className="banner banner--danger panel-repo__error" role="alert">
          <span>{`${failure.what} failed — ${failure.detail ?? "no detail"}`}</span>
          <button
            type="button"
            className="icon-btn panel-repo__dismiss"
            aria-label="Dismiss error"
            onClick={dismiss}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <dl className="panel-repo__meta">
        <div>
          <dt className="eyebrow eyebrow--faint">Branch</dt>
          <dd className="panel-repo__metaval mono">{repo.defaultBranch}</dd>
        </div>
        <div>
          <dt className="eyebrow eyebrow--faint">Monitoring</dt>
          <dd className="panel-repo__metaval">{repo.protected ? "Continuous" : "Manual"}</dd>
        </div>
      </dl>

      <footer className="panel-repo__actions">
        <button
          type="button"
          className="btn btn--sm btn--dark"
          disabled={running || triggerScan.isPending}
          onClick={runAudit}
        >
          {triggerScan.isPending ? "Starting…" : running ? "Scanning…" : "Run audit"}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={setProtect.isPending}
          onClick={() => setProtect.mutate({ repoId: repo.id, on: !repo.protected })}
        >
          {repo.protected ? <ShieldCheck size={13} /> : <Shield size={13} />}
          {repo.protected ? "Protected" : "Protect"}
        </button>
        <button
          type="button"
          className="icon-btn panel-repo__go"
          aria-label={`Open details for ${repo.fullName}`}
          onClick={() => navigate(detailPath)}
        >
          <ArrowRight size={15} />
        </button>
      </footer>
    </article>
  );
}
