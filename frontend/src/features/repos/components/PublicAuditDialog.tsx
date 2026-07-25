/** Start a read-only public repository audit: owner/repo (or github.com
 * URL) input, allowance-account selector, and the trust-boundary list. */

import { X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { publicAuditAllowanceCopy } from "../../lib/quota.ts";
import { usePanelStore } from "../../stores/panelStore.ts";
import { PanelDialog } from "./PanelDialog.tsx";

const BOUNDARIES = [
  ["01", "Public contents only"],
  ["02", "No install on target"],
  ["03", "No checks or webhooks"],
] as const;

interface PublicAuditDialogProps {
  onClose: () => void;
  onStarted: (scanId: number) => void;
}

export function PublicAuditDialog({ onClose, onStarted }: PublicAuditDialogProps) {
  const billing = usePanelStore((s) => s.billing);
  const busy = usePanelStore((s) => s.publicScanBusy);
  const publicScanError = usePanelStore((s) => s.publicScanError);
  const startPublicRepoScan = usePanelStore((s) => s.startPublicRepoScan);
  const clearPublicScanError = usePanelStore((s) => s.clearPublicScanError);

  const accounts = billing?.accounts ?? [];
  const [repository, setRepository] = useState("");
  const [installationId, setInstallationId] = useState<number | null>(
    accounts[0]?.installationId ?? null,
  );

  useEffect(() => {
    clearPublicScanError();
  }, [clearPublicScanError]);

  const selected = accounts.find((account) => account.installationId === installationId) ?? null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = repository.trim();
    if (!target || installationId === null || busy) return;
    const scanId = await startPublicRepoScan(target, installationId);
    if (scanId !== null) onStarted(scanId);
  };

  return (
    <PanelDialog ariaLabel="Audit a public repository" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog__header">
          <div>
            <span className="eyebrow">Read-only audit</span>
            <h2 className="headline panel-dialog-sub">Audit a public repository</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog__body">
          <label className="panel-field">
            <span className="eyebrow eyebrow--faint">Repository</span>
            <input
              className="input input--mono"
              placeholder="github.com/owner/repository"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              autoFocus
            />
            <span className="microtext">Accepted: owner/repo or a github.com URL.</span>
          </label>
          <label className="panel-field">
            <span className="eyebrow eyebrow--faint">Use repository allowance from</span>
            <select
              className="select"
              value={installationId ?? ""}
              onChange={(event) => setInstallationId(Number(event.target.value))}
            >
              {accounts.map((account) => (
                <option key={account.installationId} value={account.installationId}>
                  {account.accountLogin}
                </option>
              ))}
            </select>
            {selected && (
              <span className="microtext">{publicAuditAllowanceCopy(selected.publicRepoAudits)}</span>
            )}
          </label>
          <ol className="panel-boundary" aria-label="Audit boundary">
            {BOUNDARIES.map(([num, label]) => (
              <li key={num}>
                <span className="mono panel-boundary__num">{num}</span> {label}
              </li>
            ))}
          </ol>
          {publicScanError && (
            <p className="banner banner--danger panel-dialog-error" role="alert">
              {publicScanError}
            </p>
          )}
        </div>
        <div className="dialog__footer">
          <span className="microtext panel-footnote">
            Manual result only · findings never write to the target repository.
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--dark"
            disabled={busy || !repository.trim() || installationId === null}
          >
            {busy ? "Reading public snapshot…" : "Audit snapshot"}
          </button>
        </div>
      </form>
    </PanelDialog>
  );
}
