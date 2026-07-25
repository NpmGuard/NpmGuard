/**
 * Reading what IDKit's `pollUntilCompletion()` actually resolves to.
 *
 * It does **not** resolve to a proof. It resolves to an envelope:
 *
 *     { success: true, result: IDKitResult } | { success: false, error: code }
 *
 * Forwarding that envelope to the engine — and so to World's `/verify` — makes
 * World answer `validation_error`, because `/verify` wants `IDKitResult`'s own
 * fields (`protocol_version`, `nonce`, `action`, `responses`, …) at the top
 * level. The mistake is invisible to the type-checker as soon as the proof is
 * handled as `unknown`, which is why this lives in its own tested module rather
 * than inline in the page.
 *
 * `success: false` is the ordinary outcome of a user declining in World App. It
 * is not a rejected proof and must never be posted as one — the engine would
 * mark the session `failed` over something the maintainer simply cancelled.
 */

/** Cancellation copy for the codes a maintainer can actually hit. Anything not
 * listed falls through to its raw code — an unmapped code must stay legible,
 * never be flattened into a generic failure. */
const CANCELLED_COPY: Record<string, string> = {
  user_rejected: "You cancelled the request in World App.",
  verification_rejected: "World App declined to produce the proof.",
  user_presence_failed: "The presence check did not complete — this proof needs a live check.",
  credential_unavailable: "That World ID has no credential able to satisfy this request.",
  max_verifications_reached: "This World ID has already been used for this release.",
  nullifier_replayed: "This World ID has already attested this release.",
  invalid_rp_signature: "NpmGuard's request signature was refused — the server is misconfigured.",
  rp_signature_expired: "The request expired before it was signed. Start it again.",
  unknown_rp: "World does not recognise this relying party.",
  inactive_rp: "This relying party is not active in the selected environment.",
  identity_attributes_not_matched: "That identity does not satisfy the requested attributes.",
  world_id_4_not_available: "This World ID cannot produce a v4 proof.",
  connection_failed: "World App lost its connection to the bridge.",
};

export type ProofOutcome =
  /** A real proof, ready to post to the engine — never the envelope. */
  | { kind: "proof"; proof: Record<string, unknown> }
  /** World App answered, but with a refusal. Expected, not an error. */
  | { kind: "cancelled"; code: string; message: string }
  /** Nothing we can interpret; posting it would only produce a worse error. */
  | { kind: "malformed"; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn a `pollUntilCompletion()` value into the one thing the caller may post.
 *
 * Total by construction: every input is classified, so a caller cannot reach
 * the network with something World will reject.
 */
export function readCompletion(completion: unknown): ProofOutcome {
  if (!isObject(completion)) {
    return { kind: "malformed", message: "World ID returned an unreadable response." };
  }

  if (completion.success === false) {
    const code = typeof completion.error === "string" ? completion.error : "generic_error";
    return { kind: "cancelled", code, message: CANCELLED_COPY[code] ?? `World ID: ${code}` };
  }

  if (completion.success === true) {
    // The envelope is only useful for what it wraps.
    if (isObject(completion.result)) return { kind: "proof", proof: completion.result };
    return { kind: "malformed", message: "World ID returned a proof with no result." };
  }

  return { kind: "malformed", message: "World ID returned an unrecognised response." };
}
