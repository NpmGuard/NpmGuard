import { useEffect, useState } from "react";
import {
  verifyPackageCertificate,
  type CertificateVerificationResult,
} from "../lib/certificate-verification";

interface CertificateVerifyDialogProps {
  packageName: string;
  version: string;
  onClose: () => void;
}

function shortHash(value: string): string {
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

export function CertificateVerifyDialog({
  packageName,
  version,
  onClose,
}: CertificateVerifyDialogProps) {
  const [result, setResult] = useState<CertificateVerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void verifyPackageCertificate(packageName, version)
      .then((verification) => {
        if (!cancelled) setResult(verification);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Verification failed");
        }
      });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, packageName, version]);

  const verificationState = error
    ? "error"
    : result?.valid === true
      ? "valid"
      : result
        ? "invalid"
        : "loading";

  return (
    <div
      className="certificate-verify-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="certificate-verify-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="certificate-verify-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="certificate-verify-close"
          onClick={onClose}
          aria-label="Close certificate verification"
        >
          ×
        </button>

        <header className="certificate-verify-head">
          <span className="certificate-verify-kicker">Independent browser check</span>
          <h2 id="certificate-verify-title">Verify audit proof</h2>
          <p>
            <strong>{packageName}</strong>
            <span>@{version}</span>
          </p>
        </header>

        <div
          className={`certificate-verify-status certificate-verify-status--${verificationState}`}
          role="status"
        >
          <span className="certificate-verify-status__mark" aria-hidden="true">
            {verificationState === "loading"
              ? "···"
              : verificationState === "valid"
                ? "✓"
                : "!"}
          </span>
          <div>
            <strong>
              {verificationState === "loading"
                ? "Reconstructing proof"
                : verificationState === "valid"
                  ? "Valid on-chain"
                  : verificationState === "invalid"
                    ? "Proof mismatch"
                    : "Could not verify"}
            </strong>
            <span>
              {verificationState === "loading"
                ? "Hashing the report and reading Base…"
                : verificationState === "valid"
                  ? "The report is included in the root published on Base."
                  : error ?? "At least one verification step did not match."}
            </span>
          </div>
        </div>

        <ol className="certificate-verify-trace">
          {(result?.checks ??
            [
              { id: "report", label: "Report integrity" },
              { id: "certificate", label: "Certificate leaf" },
              { id: "merkle", label: "Merkle path" },
              { id: "manifest", label: "Batch manifest" },
              { id: "chain", label: "Base transaction" },
            ]).map((check) => {
            const passed = "passed" in check ? check.passed : null;
            return (
              <li
                key={check.id}
                className={
                  passed === null
                    ? "is-pending"
                    : passed
                      ? "is-valid"
                      : "is-invalid"
                }
              >
                <span className="certificate-verify-trace__node" aria-hidden="true">
                  {passed === null ? "" : passed ? "✓" : "×"}
                </span>
                <div>
                  <strong>{check.label}</strong>
                  <span>
                    {"detail" in check ? check.detail : "Waiting for verification"}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>

        {result && (
          <dl className="certificate-verify-ledger">
            <div>
              <dt>Merkle root</dt>
              <dd title={result.certificate.anchor.merkleRoot}>
                {shortHash(result.certificate.anchor.merkleRoot)}
              </dd>
            </div>
            <div>
              <dt>Certificate</dt>
              <dd title={result.certificate.certificateHash}>
                {shortHash(result.certificate.certificateHash)}
              </dd>
            </div>
          </dl>
        )}

        <footer className="certificate-verify-actions">
          <span>Calculated locally in this browser</span>
          {result && (
            <a href={result.explorerUrl} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          )}
        </footer>
      </section>
    </div>
  );
}
