/** Start a read-only public repository audit: owner/repo (or github.com
 * URL) input, allowance-account selector, and the trust-boundary list. */

import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PanelDialog } from "../../../components/panel/PanelDialog.tsx";
import { actionFailure } from "../../../lib/query-state.ts";
import { publicAuditAllowanceCopy } from "../../billing/quota.ts";
import { useBilling } from "../../billing/hooks.ts";
import { useStartPublicScan } from "../hooks.ts";

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
  const billing = useBilling();
  const scan = useStartPublicScan();

  // The allowance accounts are the ONLY thing this dialog needs from billing, and
  // the hero that opens it is already gated on having them — so an unreadable
  // ledger leaves an empty selector rather than a fabricated one.
  const accounts = billing.status === "ok" ? billing.data.accounts : [];
  const busy = scan.isPending;
  // A cap belongs to the paywall, so it is filtered out here; anything else is
  // this form's own error to show.
  const failure = actionFailure(scan.error, "Starting the repository audit");

  const [repository, setRepository] = useState("");
  const [installationId, setInstallationId] = useState<number | null>(
    accounts[0]?.installationId ?? null,
  );

  const selected = accounts.find((account) => account.installationId === installationId) ?? null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = repository.trim();
    if (!target || installationId === null || busy) return;
    scan.mutate(
      { repository: target, installationId },
      { onSuccess: ({ scanId }) => onStarted(scanId) },
    );
  };

  return (
    <PanelDialog ariaLabel="Audit a public repository" onClose={onClose}>
      <form onSubmit={submit}>
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
          {failure && (
            <p className="banner banner--danger panel-dialog-error" role="alert">
              {failure.detail ?? failure.what}
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
