/**
 * Attest a release (/attest) — the entry point into publisher attestation.
 *
 * Everything downstream of here already existed: the session page, the World
 * proof, the enrolment. What was missing was a door. The CLI could open a
 * session (`npmguard attest pkg@version`); the web app could only render one
 * you already had a link to.
 *
 * This page decides nothing. It takes `name@version`, asks the engine to open a
 * session, and forwards to it — the version is resolved against npm server-side
 * and the tarball digest comes back from the registry, never from this form.
 *
 * Composes base.css primitives; shares src/styles/attest.css with the pages it
 * leads into (`.pg-publish-…`).
 */

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { BadgeCheck, ArrowRight, Package, ShieldCheck } from "lucide-react";
import { createAttestSession } from "../lib/api.ts";
import { parsePackageInput } from "../lib/types.ts";
import "../styles/attest.css";

export function Publish() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const { name, version } = parsePackageInput(input);
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      // No version means the newest release — the same default the CLI and the
      // registry itself use. The engine answers with the concrete semver.
      const session = await createAttestSession(name, version ?? "latest");
      navigate(`/attest/${session.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open an attestation session");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page__inner fade-up pg-publish">
      <p className="eyebrow">Publisher attestation</p>
      <h1 className="headline">Attest a release</h1>
      <p className="muted pg-attest__lede">
        Prove a real human published this exact tarball. A stolen npm token can publish;
        it cannot produce this proof.
      </p>

      <form className="pg-publish__form" onSubmit={(e) => void onSubmit(e)}>
        <label className="pg-publish__label" htmlFor="pg-publish-input">
          Package
        </label>
        <div className="pg-publish__row">
          <span className="pg-publish__icon" aria-hidden>
            <Package size={16} />
          </span>
          <input
            id="pg-publish-input"
            className="input input--mono pg-publish__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="axios@1.14.1"
            autoComplete="off"
            spellCheck={false}
            aria-label="Package name and version to attest"
          />
          <button
            type="submit"
            className="btn btn--dark pg-publish__go"
            disabled={busy || input.trim() === ""}
          >
            {busy ? "Opening…" : "Attest"} <ArrowRight size={15} aria-hidden />
          </button>
        </div>
        <p className="muted pg-publish__hint">
          Leave the version off to attest the newest release.
        </p>
      </form>

      {error && (
        <p className="pg-attest__error" role="alert">
          {error}
        </p>
      )}

      <div className="pg-publish__cards">
        <section className="card pg-publish__card">
          <h2 className="headline headline--sm">
            <ShieldCheck size={16} aria-hidden /> Every release. Every time.
          </h2>
          <p className="muted">
            A live check bound to this exact tarball. Yesterday's proof cannot sign today's
            release, so there is nothing on your machine — npm token, CI secret, a worm
            holding both — that can produce one.
          </p>
        </section>
        <section className="card pg-publish__card">
          <h2 className="headline headline--sm">
            <BadgeCheck size={16} aria-hidden /> Identity check
          </h2>
          <p className="muted">
            The document scan is the one thing you do once — repeating it per release would
            prove nothing new, and it cannot be bound to a tarball at all. It upgrades what
            your proofs say about you. It never replaces one.
          </p>
          <Link className="btn pg-publish__link" to="/attest/enrol">
            Set up identity check
          </Link>
        </section>
      </div>
    </div>
  );
}
