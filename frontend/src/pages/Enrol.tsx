/**
 * Identity Check enrolment — prove you are a document-verified adult, once.
 *
 * Separate from `Attest.tsx` on purpose, and the separation is forced by the
 * protocol rather than chosen for tidiness: `IdentityCheck` is the only preset
 * that accepts no `signal`, so an attribute proof cannot be bound to a tarball.
 * Binding is what makes a release proof unforgeable, so the two cannot be the
 * same step.
 *
 * What this page does NOT do is authorize anything. It records that the human
 * behind one World pseudonym holds a document-backed credential. Publishing a
 * release still needs its own signal-bound proof, every time.
 *
 * Composes base.css primitives; reuses src/styles/attest.css.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { BadgeCheck, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  fetchEnrolRequest,
  submitEnrolProof,
  type EnrolRequestConfig,
  type EnrolmentResponse,
} from "../lib/api.ts";
import { readCompletion } from "../lib/idkit-completion.ts";
import "../styles/attest.css";

export function Enrol() {
  const [config, setConfig] = useState<EnrolRequestConfig | null>(null);
  const [enrolment, setEnrolment] = useState<EnrolmentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchEnrolRequest()
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load the enrolment request");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    if (!config) return;
    setError(null);
    setDiagnostic(null);
    setWaiting(true);
    try {
      const [idkit, qrcode] = await Promise.all([
        import("@worldcoin/idkit-core"),
        import("qrcode"),
      ]);
      const request = await idkit.IDKit.request({
        app_id: config.appId as `app_${string}`,
        action: config.action,
        rp_context: config.rpContext,
        environment: config.environment as "production" | "staging" | "sandbox",
        require_user_presence: config.requireUserPresence,
        allow_legacy_proofs: config.allowLegacyProofs,
        // The attribute list comes from the engine, never from here — the
        // browser must not be able to widen what we ask World for.
      }).preset(
        idkit.identityCheck({
          attributes: config.attributes as never,
        }),
      );

      setUri(request.connectorURI);
      setQr(await qrcode.toDataURL(request.connectorURI, { margin: 1, width: 240 }));

      const outcome = readCompletion(await request.pollUntilCompletion());
      if (outcome.kind !== "proof") {
        const report = request.getDebugReport();
        console.warn("[npmguard/idkit] enrolment produced no proof", outcome, report);
        setError(outcome.message);
        setDiagnostic(
          JSON.stringify(
            {
              code: outcome.kind === "cancelled" ? outcome.code : "malformed_completion",
              requested: {
                preset: "IdentityCheck",
                attributes: config.attributes,
                environment: config.environment,
              },
              package_version: report.package_version,
              response_payload: report.response_payload,
            },
            null,
            2,
          ),
        );
        return;
      }
      setEnrolment(await submitEnrolProof(outcome.proof));
    } catch (err) {
      setError(err instanceof Error ? err.message : "World ID returned an error");
    } finally {
      setWaiting(false);
    }
  }, [config]);

  function copyUri() {
    if (!uri) return;
    void navigator.clipboard?.writeText(uri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <main className="page">
      <div className="page__inner fade-up pg-attest">
        <p className="eyebrow">Identity check</p>
        <h1 className="headline">Enrol as a verified publisher</h1>
        <p className="muted pg-attest__lede">
          A one-time check that adds <strong>document-verified adult</strong> to your
          publisher identity. Every release still needs its own live proof.
        </p>

        {config && !config.isProduction && (
          <div className="pg-attest__staging" role="status">
            <TriangleAlert size={16} aria-hidden />
            <span>
              <strong>Staging</strong> — this is a World ID test environment. Proofs made
              here are not real-world credentials.
            </span>
          </div>
        )}

        {enrolment ? (
          <div className="pg-attest__result">
            <p className="pg-attest__tier">
              <BadgeCheck size={18} aria-hidden />
              <strong>Identity-checked</strong>
            </p>
            <p className="muted">
              Releases you attest will now be recorded at tier {enrolment.tier}.
            </p>
            <dl className="pg-attest__facts">
              <div>
                <dt>Publisher</dt>
                <dd title={enrolment.nullifier}>
                  <code>{enrolment.nullifier.slice(0, 18)}…</code>
                </dd>
              </div>
            </dl>
            <p className="muted pg-attest__privacy">
              Stored as a pseudonymous identifier and yes/no answers. Each publish still
              needs its own proof.
            </p>
            <p>
              <Link to="/packages">Back to packages</Link>
            </p>
          </div>
        ) : (
          <>
            <section className="pg-enrol-ask">
              <h2 className="pg-enrol-ask__title">What World is asked</h2>
              <div className="pg-enrol-ask__cols">
                <div className="pg-enrol-ask__col pg-enrol-ask__col--yes">
                  <p className="pg-enrol-ask__head">Asked</p>
                  <ul>
                    {config ? (
                      config.attributes.map((a) => (
                        <li key={a.type}>
                          {a.type.replace(/_/g, " ")} ≥ {a.value}
                        </li>
                      ))
                    ) : (
                      <li className="pg-enrol-ask__wait">Loading…</li>
                    )}
                  </ul>
                </div>
                <div className="pg-enrol-ask__col pg-enrol-ask__col--no">
                  <p className="pg-enrol-ask__head">Never asked</p>
                  <ul>
                    <li>Your name</li>
                    <li>Document number</li>
                    <li>Nationality</li>
                  </ul>
                </div>
              </div>
            </section>

            {!uri && (
              <button
                type="button"
                className="btn btn--dark pg-attest__cta"
                onClick={() => void start()}
                disabled={!config || waiting}
                aria-label="Start identity check"
              >
                <ShieldCheck size={16} aria-hidden /> Start identity check
              </button>
            )}

            {uri && (
              <div className="pg-attest__proof">
                {qr && (
                  <img
                    className="pg-attest__qr"
                    src={qr}
                    alt="World ID QR code"
                    width={240}
                    height={240}
                  />
                )}
                <div className="pg-attest__uri">
                  <p className="muted">
                    {config?.isProduction
                      ? "Scan with World App."
                      : "Staging: open the World simulator and paste this link:"}
                  </p>
                  <code className="pg-attest__link">{uri}</code>
                  <button type="button" className="btn pg-attest__cta" onClick={copyUri}>
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
                {waiting && <p className="muted">Waiting for your proof…</p>}
              </div>
            )}
          </>
        )}

        {error && (
          <p className="pg-attest__error" role="alert">
            {error}
          </p>
        )}
        {diagnostic && (
          <details className="pg-attest__diagnostic">
            <summary>What World ID reported</summary>
            <pre>{diagnostic}</pre>
          </details>
        )}
        {uri && !waiting && !enrolment && (
          <button type="button" className="btn pg-attest__cta" onClick={() => void start()}>
            Try again
          </button>
        )}
      </div>
    </main>
  );
}
