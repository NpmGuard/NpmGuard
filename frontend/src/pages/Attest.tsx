/**
 * Publisher attestation — prove a human published this release.
 *
 * Three steps, each gated by the engine: confirm the release, prove GitHub push
 * access, then produce a World ID proof bound to this exact tarball. The page
 * decides nothing. It renders what `/attest/session/:id` reports and forwards
 * the proof; ownership, the signal binding and the tier are all settled
 * server-side.
 *
 * The STAGING banner is load-bearing, not decoration: a staging proof carries no
 * real-world assurance, and the screen must never let one read as though it did.
 *
 * Composes base.css primitives; owns src/styles/attest.css (`.pg-attest-…`).
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { CheckCircle2, GitBranch, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  fetchAttestRequest,
  fetchAttestSession,
  proveAttestOwnership,
  submitAttestProof,
  type AttestRequestConfig,
  type AttestSessionResponse,
} from "../lib/api.ts";
import { ApiError } from "../lib/api-base.ts";
import { readCompletion } from "../lib/idkit-completion.ts";
import "../styles/attest.css";

const TIER_LABEL: Record<number, string> = {
  1: "Human-attested",
  2: "Identity-checked",
  3: "Identity-checked + jurisdiction",
};

const TIER_BLURB: Record<number, string> = {
  1: "A unique human was present and consented to this exact tarball.",
  2: "…and holds a document-backed World ID credential.",
  3: "…and declared an issuing jurisdiction.",
};

/** Tier 1's whole sentence is "a human was **present**". When the proof carries
 * no presence check that sentence is simply false, so it is not shown — the
 * artifact binding still holds and is worth stating on its own. */
function tierBlurb(tier: number, assertions: Record<string, boolean>): string {
  if (tier === 1 && assertions.user_present === false) {
    return "A unique human consented to this exact tarball. No live presence check was performed, so this does not prove they were there at the time.";
  }
  return TIER_BLURB[tier] ?? "";
}

function StepMarker({ done, active, n }: { done: boolean; active: boolean; n: number }) {
  const state = done ? "done" : active ? "active" : "todo";
  return (
    <span className={`pg-attest-step__marker pg-attest-step__marker--${state}`}>
      {done ? <CheckCircle2 size={16} aria-hidden /> : n}
    </span>
  );
}

export function Attest() {
  const { sessionId = "" } = useParams();
  const [session, setSession] = useState<AttestSessionResponse | null>(null);
  const [config, setConfig] = useState<AttestRequestConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSession(await fetchAttestSession(sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this session");
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Once ownership is proven the engine will mint an RP signature; fetch it so
  // the widget has something to bind to.
  useEffect(() => {
    if (session?.status !== "owned" && session?.status !== "failed") return;
    let cancelled = false;
    void fetchAttestRequest(sessionId)
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the request");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.status, sessionId]);

  async function onProveOwnership() {
    setBusy(true);
    setError(null);
    try {
      setSession(await proveAttestOwnership(sessionId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Bounce through the panel's existing GitHub OAuth and come back here.
        window.location.href = `/auth/github/login?next=${encodeURIComponent(
          `/attest/${sessionId}`,
        )}`;
        return;
      }
      setError(err instanceof Error ? err.message : "Could not verify ownership");
    } finally {
      setBusy(false);
    }
  }

  const onProof = useCallback(
    async (proof: unknown) => {
      setBusy(true);
      setError(null);
      try {
        setSession(await submitAttestProof(sessionId, proof));
      } catch (err) {
        setError(err instanceof Error ? err.message : "The proof was rejected");
        void load();
      } finally {
        setBusy(false);
      }
    },
    [sessionId, load],
  );

  if (error && session === null) {
    return (
      <main className="page">
        <div className="page__inner pg-attest">
          <p className="pg-attest__error" role="alert">
            {error}
          </p>
        </div>
      </main>
    );
  }

  if (session === null) {
    return (
      <main className="page">
        <div className="page__inner pg-attest">
          <p className="muted">Loading attestation session…</p>
        </div>
      </main>
    );
  }

  // "failed" keeps its proven ownership — a rejected proof is retryable, and
  // bouncing the maintainer back to step 2 would suggest they lost it.
  const owned =
    session.status === "owned" || session.status === "verified" || session.status === "failed";
  const verified = session.status === "verified";
  const attestation = session.attestation;
  const staging = config !== null && !config.isProduction;

  return (
    <main className="page">
      <div className="page__inner fade-up pg-attest">
        <p className="eyebrow">Publisher attestation</p>
        <h1 className="headline">
          {session.packageName}
          <span className="pg-attest__version">@{session.version}</span>
        </h1>
        <p className="muted pg-attest__lede">
          Prove a human published this release. Every version needs its own proof — that
          is what a stolen token or a self-replicating worm cannot produce.
        </p>

        {(staging || attestation?.environment === "staging") && (
          <div className="pg-attest__staging" role="status">
            <TriangleAlert size={16} aria-hidden />
            <span>
              <strong>Staging</strong> — this is a World ID test environment. Proofs made
              here are not real-world credentials.
            </span>
          </div>
        )}

        <ol className="pg-attest-steps">
          <li className="pg-attest-step">
            <StepMarker n={1} done active={false} />
            <div>
              <h2 className="pg-attest-step__title">Release confirmed</h2>
              <p className="muted">
                Resolved from npm — the tarball digest is what your proof will be bound to.
              </p>
            </div>
          </li>

          <li className="pg-attest-step">
            <StepMarker n={2} done={owned} active={!owned} />
            <div>
              <h2 className="pg-attest-step__title">Prove you maintain it</h2>
              {owned ? (
                <p className="muted">
                  Push access confirmed{session.githubLogin ? ` as ${session.githubLogin}` : ""}.
                </p>
              ) : (
                <>
                  <p className="muted">
                    Sign in with GitHub. We check push access to the repository this package
                    declares.
                  </p>
                  <button
                    type="button"
                    className="btn btn--dark pg-attest__cta"
                    onClick={() => void onProveOwnership()}
                    disabled={busy}
                    aria-label="Verify GitHub ownership"
                  >
                    <GitBranch size={16} aria-hidden /> Continue with GitHub
                  </button>
                </>
              )}
            </div>
          </li>

          <li className="pg-attest-step">
            <StepMarker n={3} done={verified} active={owned && !verified} />
            <div>
              <h2 className="pg-attest-step__title">Prove you are human</h2>
              {verified && attestation ? (
                <div className="pg-attest__result">
                  <p className="pg-attest__tier">
                    <ShieldCheck size={18} aria-hidden />
                    <strong>{TIER_LABEL[attestation.tier] ?? `Tier ${attestation.tier}`}</strong>
                  </p>
                  <p className="muted">{tierBlurb(attestation.tier, attestation.assertions)}</p>
                  <dl className="pg-attest__facts">
                    <div>
                      <dt>Publisher</dt>
                      <dd title={attestation.nullifier}>
                        <code>{attestation.nullifier.slice(0, 18)}…</code>
                      </dd>
                    </div>
                    {attestation.storageRoot && (
                      <div>
                        <dt>0G Storage</dt>
                        <dd>
                          <code>{attestation.storageRoot.slice(0, 18)}…</code>
                        </dd>
                      </div>
                    )}
                    {attestation.chainTx && (
                      <div>
                        <dt>0G Chain</dt>
                        <dd>
                          <code>{attestation.chainTx.slice(0, 18)}…</code>
                        </dd>
                      </div>
                    )}
                  </dl>
                  <p className="muted pg-attest__privacy">
                    We stored a pseudonymous identifier and yes/no assertions — never your
                    name, document number or nationality.
                  </p>
                  {attestation.tier < 2 && (
                    <p className="muted">
                      <Link to="/attest/enrol">Complete an identity check</Link> once, and
                      every release you attest afterwards carries document-backed assurance
                      — without scanning anything again.
                    </p>
                  )}
                </div>
              ) : owned && config ? (
                <WorldProof
                  config={config}
                  onProof={onProof}
                  onAttemptStart={() => setError(null)}
                  busy={busy}
                />
              ) : (
                <p className="muted">Complete step 2 first.</p>
              )}
            </div>
          </li>
        </ol>

        {error && (
          <p className="pg-attest__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

/**
 * The World ID proof step.
 *
 * Uses `IDKit.request` rather than the drop-in widget so the **connector URI is
 * visible**. The widget renders the URI only inside a QR image, which is
 * unusable when the verifier is the World simulator running in another tab on
 * the same machine — there is nothing to point a camera at. Showing the link
 * makes staging testing possible at all, and costs a production user nothing.
 *
 * Loaded lazily: IDKit pulls a WASM bundle, and a maintainer who never reaches
 * step 3 should not pay for it.
 */
function WorldProof({
  config,
  onProof,
  onAttemptStart,
  busy,
}: {
  config: AttestRequestConfig;
  onProof: (proof: Record<string, unknown>) => Promise<void>;
  onAttemptStart: () => void;
  busy: boolean;
}) {
  const [loadError, setLoadError] = useState<string | null>(null);
  // What IDKit reported when it produced no proof. Kept beside the friendly
  // message because the friendly message is for the maintainer and this is for
  // whoever has to fix it — usually not the same person, and usually not at the
  // same time.
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function startRequest() {
    setLoadError(null);
    setDiagnostic(null);
    // Clear the *page* error too. A stale "World rejected the proof" left over
    // from a previous attempt, sitting under a fresh one, reads as two failures
    // and sent us chasing the wrong one once already.
    onAttemptStart();
    setWaiting(true);
    try {
      const [idkit, qrcode] = await Promise.all([
        import("@worldcoin/idkit-core"),
        import("qrcode"),
      ]);
      const { IDKit } = idkit;
      // All three presets accept a `signal`, so the artifact binding is the same
      // whichever the engine asks for. A World ID that holds a document
      // credential may hold no Orb credential at all, and vice versa — which is
      // a `credential_unavailable` the publisher cannot resolve on the spot, so
      // which one to ask for has to be operator-configurable.
      const PRESETS = {
        proof_of_human: idkit.proofOfHuman,
        passport: idkit.passport,
        mnc: idkit.mnc,
      };
      const preset = PRESETS[config.credential] ?? idkit.proofOfHuman;
      // Named once so the diagnostic below reports what was actually asked for
      // rather than a hand-copied guess that can drift from it.
      const asked = {
        // REQUIRED for staging. IDKit's `environment` is optional and defaults
        // to "production", so omitting it produces a production request that the
        // World simulator refuses with "Production request detected" — the
        // engine is the authority on which environment this app is configured
        // for, so it always travels with the request.
        environment: config.environment as "production" | "staging" | "sandbox",
        require_user_presence: config.requireUserPresence,
        // Legacy (v3) proofs predate the v4 credential model. Whether one may
        // answer is the engine's call, not this bundle's — it decides what an
        // attestation is allowed to mean, and it records the protocol version
        // so a legacy one is never mistaken for a current one.
        allow_legacy_proofs: config.allowLegacyProofs,
      };
      const request = await IDKit.request({
        app_id: config.appId as `app_${string}`,
        action: config.action,
        // Minted server-side; the signing key never reaches this bundle.
        rp_context: config.rpContext,
        ...asked,
        // The signal is what binds the proof to this exact tarball. Every preset
        // here accepts one; IdentityCheck is the only preset that cannot, which
        // is why enrolment and per-release proof are separate steps.
      }).preset(preset({ signal: config.signal }));

      setUri(request.connectorURI);
      setQr(await qrcode.toDataURL(request.connectorURI, { margin: 1, width: 240 }));

      // `pollUntilCompletion` resolves to an envelope, not a proof. Posting the
      // envelope is what World's /verify answers `validation_error` to.
      const outcome = readCompletion(await request.pollUntilCompletion());
      if (outcome.kind !== "proof") {
        // IDKit's own diagnostic. An error code alone says a credential was
        // unusable but not which one was asked for, and the request/response
        // payloads here are the only place that shows both sides.
        const report = request.getDebugReport();
        console.warn("[npmguard/idkit] no proof", outcome, report);
        setLoadError(outcome.message);
        setDiagnostic(
          JSON.stringify(
            {
              code: outcome.kind === "cancelled" ? outcome.code : "malformed_completion",
              requested: { credential: config.credential, ...asked },
              package_version: report.package_version,
              transport: report.transport,
              response_payload: report.response_payload,
            },
            null,
            2,
          ),
        );
        return;
      }
      await onProof(outcome.proof);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "World ID returned an error");
    } finally {
      setWaiting(false);
    }
  }

  function copyUri() {
    if (!uri) return;
    void navigator.clipboard?.writeText(uri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <>
      <p className="muted">
        This asks for a fresh liveness check bound to this exact release — a proof for
        one tarball is worthless for any other.
      </p>

      {!uri && (
        <button
          type="button"
          className="btn btn--dark pg-attest__cta"
          onClick={() => void startRequest()}
          disabled={busy || waiting}
          aria-label="Prove with World ID"
        >
          <ShieldCheck size={16} aria-hidden /> Prove with World ID
        </button>
      )}

      {uri && (
        <div className="pg-attest__proof">
          {qr && <img className="pg-attest__qr" src={qr} alt="World ID QR code" width={240} height={240} />}
          <div className="pg-attest__uri">
            <p className="muted">
              {config.isProduction
                ? "Scan with World App."
                : "Staging: World App will refuse this. Open the World simulator and paste this link:"}
            </p>
            {!config.isProduction && (
              <p>
                <a href="https://simulator.orb.engineer" target="_blank" rel="noreferrer">
                  simulator.orb.engineer
                </a>
              </p>
            )}
            <code className="pg-attest__link">{uri}</code>
            <button type="button" className="btn pg-attest__cta" onClick={copyUri}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          {waiting && <p className="muted">Waiting for your proof…</p>}
        </div>
      )}

      {loadError && <p className="pg-attest__error">{loadError}</p>}
      {diagnostic && (
        <details className="pg-attest__diagnostic">
          <summary>What World ID reported</summary>
          <pre>{diagnostic}</pre>
        </details>
      )}
      {uri && !waiting && (
        <button
          type="button"
          className="btn pg-attest__cta"
          onClick={() => void startRequest()}
          disabled={busy}
        >
          Try again
        </button>
      )}
    </>
  );
}
