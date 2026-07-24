/** Repository card for the dashboard grid. Accent bar follows the last
 * scan's tone; per-repo action errors render inline and dismissible so a
 * single failure never poisons the whole dashboard. */

import { ArrowRight, Shield, ShieldCheck, X } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { useNavigate } from "react-router";
import type { PanelRepo } from "../../lib/engine-types.ts";
import { usePanelStore } from "../../stores/panelStore.ts";
import { ScanStatus } from "./ScanStatus.tsx";
import { scanTone, toneAccent } from "./tone.tsx";

export function RepoCard({ repo }: { repo: PanelRepo }) {
  const navigate = useNavigate();
  const triggerScan = usePanelStore((s) => s.triggerScan);
  const setProtect = usePanelStore((s) => s.setProtect);
  const clearRepoActionError = usePanelStore((s) => s.clearRepoActionError);
  const actionError = usePanelStore((s) => s.repoActionErrors[repo.id]);

  const [auditBusy, setAuditBusy] = useState(false);
  const [protectBusy, setProtectBusy] = useState(false);

  const running = repo.lastScan?.status === "running";
  const detailPath = `/repo/${repo.owner}/${repo.name}`;

  const runAudit = async () => {
    setAuditBusy(true);
    const scanId = await triggerScan(repo.id);
    setAuditBusy(false);
    if (scanId !== null) navigate(detailPath);
  };

  const toggleProtect = async () => {
    setProtectBusy(true);
    await setProtect(repo.id, !repo.protected);
    setProtectBusy(false);
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

      {actionError && (
        <div className="banner banner--danger panel-repo__error" role="alert">
          <span>{actionError.message}</span>
          <button
            type="button"
            className="icon-btn panel-repo__dismiss"
            aria-label="Dismiss error"
            onClick={() => clearRepoActionError(repo.id)}
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
          disabled={running || auditBusy}
          onClick={() => void runAudit()}
        >
          {auditBusy ? "Starting…" : running ? "Scanning…" : "Run audit"}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={protectBusy}
          onClick={() => void toggleProtect()}
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
