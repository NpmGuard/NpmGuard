# World ID — Identity Check beta test: developer & user feedback

**Project:** NpmGuard — human-attested npm releases
**Contact:** see repo contributors
**Date opened:** 2026-07-25 (ETHGlobal Lisbon)
**Status:** developer feedback = findings below, gathered while integrating.
D-1…D-12 come from building against the SDK; **D-13 and D-14 come from a live
staging proof that World rejected**, and are the only two that cost us real
debugging time rather than reading time — worth weighting accordingly.
User feedback = protocol defined, sessions pending.

Versions under test:

| | |
|---|---|
| `@worldcoin/idkit` | **4.2.1** (published 2026-07-17T23:08Z) |
| `@worldcoin/idkit-core` | **4.2.2** (published 2026-07-17T20:11Z) |
| Verify API | `POST https://developer.world.org/api/v4/verify/{rp_id}`, protocol `4.0` |
| Environment | `staging` + simulator |

Every claim below is traceable to a line in the **published** `idkit-core@4.2.2`
type declarations (`dist/index.d.ts`) or to a docs URL, so each is reproducible
without our codebase.

---

## Open questions for the World team

The short list to raise in person. Each is expanded in the findings below.

| # | Question | Why it blocks us |
|---|---|---|
| **Q1** | Can `IdentityCheck` get a `signal`? It is the only preset of nine without one. | Without it an attribute proof cannot be bound to the artifact it authorizes — it is replayable. **D-1** |
| **Q2** | Can `identity_attested` report per-attribute results instead of one boolean? | A tiered product cannot degrade gracefully; each tier becomes another user scan. **D-2** |
| **Q3** | What is the nullifier's derivation scope — `(identity, app, action)` or `(identity, app, action, credential_type)`? | Decides whether two credential types can be linked to one publisher, or whether onboarding needs an extra scan. **D-9** |
| **Q4** | Can the **simulator** issue Identity Check document attributes, or does tier 2 require a real document? | Decides whether our document-backed tier is demoable at all without real documents. **D-6** |
| **Q5** | Is there a documented spec (or non-JS implementation) of `hashSignal` **and `signRequest`**? | A non-JS backend must reverse-engineer *two* undocumented schemes before it can sign or verify anything — and `signRequest`'s reference implementation refuses to run outside Node by design. **D-11, D-12** |
| **Q6** | Does `/api/v4/verify/{rp_id}` echo `identity_attested`, or must the backend trust the client payload? | Attribute verification is precisely what a backend must not take on trust. **D-3** |
| **Q7** | Can `validation_error` name the offending field, and can the completion envelope be made un-postable by construction? | The one failure that actually stopped us in testing. A correct proof was rejected because we forwarded IDKit's `{success, result}` wrapper; the error pointed at the proof, not the wrapper. **D-13, D-14** |
| **Q8** | Does the nullifier's derivation include **protocol version** and/or **credential type**? We measured two different nullifiers for one identity under one app+action. | This is the sharpest one. The nullifier is documented as a durable pseudonym, and our whole product keys publisher continuity on it. If it changes with the proof type, every publisher's history silently resets and we raise a false alarm against an honest maintainer. **D-15** (supersedes the narrower **Q3/D-9**) |

---

## What we are building, in one paragraph

Most large npm supply-chain attacks do not break code — they break a *person*.
An attacker phishes a maintainer's token, or a worm steals it from a dev machine,
and publishes a malicious version of a trusted package. The tarball looks normal.
Our layer: a maintainer proves, **per release**, that a unique, document-verified
human was present and consented to *one exact tarball*. Then the signal is not
"this version is unattested" (99.99% of npm is) — it is "the last 40 releases of
this package were attested by publisher N, and this one is attested by nobody."
A worm cannot produce that proof.

This is why we need Identity Check specifically, and why the findings below are
about **binding and granularity** rather than about the happy path.

---

## Developer feedback

Ordered by how much each one costs an integrator.

### D-1 🔴 `IdentityCheck` is the only preset with no `signal` — app context cannot be bound into the proof

In `idkit-core@4.2.2/dist/index.d.ts`, eight of the nine presets expose
`signal?: string` (lines 295–338). `IdentityCheckPreset` (line 341) exposes only
`legacy_signal`:

```ts
interface IdentityCheckPreset {
    /** This preset requires World ID 4.0-compatible clients. */
    type: "IdentityCheck";
    attributes: IdentityAttribute[];
    legacy_signal?: string;      // ← no `signal`
}
```

`signal` is the documented mechanism for binding app context into a proof, and
the response carries `signal_hash` (lines 115/131/145) so a backend can verify
the binding. With `identityCheck()` there is no way to produce that binding.

**Why this is blocking for us, not cosmetic.** Our whole security claim is that a
proof is bound to one artifact: `signal = H(package ‖ version ‖ tarball digest)`.
Without it, a proof obtained for `lodash@4.17.21` is replayable onto any other
tarball — which is precisely the attack we exist to stop.

**The workaround is not a workaround.** The remaining per-request binding is
`action`, but `action` is what scopes the nullifier. Putting the artifact digest
in `action` gives a *different nullifier per release*, which destroys the stable
publisher pseudonym that the continuity signal is built on. So as shipped, an
integrator must choose:

- stable publisher identity (fixed `action`) **without** artifact binding, or
- artifact binding (digest in `action`) **without** a stable publisher identity.

We need both simultaneously. We believe this is the single highest-value fix.

**`.constraints()` does not bridge it either.** `CredentialRequest(type, {signal})`
(line ~535) does accept a signal, and `any`/`all`/`enumerate` compose those into a
`ConstraintNode`. But identity attributes are only expressible through
`identityCheck()`, which returns a `Preset` and is consumed by `.preset()` —
and `.preset()` / `.constraints()` are alternative transports on the builder
(lines 735–754). There is no documented way to request identity attributes *and*
a signal in one request.

**Asks, in order of preference:** add `signal?: string` to `IdentityCheckPreset`;
or allow identity attributes inside a `CredentialRequest` so `.constraints()` can
carry both; or document an approved pattern for artifact-bound attribute proofs.

### D-2 🔴 `identity_attested` is one boolean for the whole attribute set

```ts
/** Whether identity attributes were attested. Only present on IdentityCheck responses. */
identity_attested?: boolean;
```
(`idkit-core@4.2.2/dist/index.d.ts:193`)

There is no per-attribute result. If a request asks for `document_type: passport`
**and** `minimum_age: 18`, a `false` does not say which failed — and the error
enum has a single matching code, `IdentityAttributesNotMatched =
"identity_attributes_not_matched"` (line 417), with no per-attribute detail.

**Cost to integrators.** Any product with assurance *tiers* — ours has three —
cannot degrade gracefully. We would like "give me everything you can, tell me
what matched, and I will grade the result." Instead each tier must be a separate
request, and each request is a separate World App round-trip for the user. A
3-tier design becomes up to 3 scans. That is a direct, measurable drop-off cost,
and it pushes integrators toward requesting *fewer* attributes than they would
otherwise verify — the opposite of what data-minimization guidance wants, since
the cheapest design becomes "ask for the strongest tier only and reject everyone
else."

**Ask:** return per-attribute results, e.g.
`identity_attested: { document_type: true, minimum_age: false }`, or an
`attested_attributes: string[]` alongside the boolean. Additive and
backward-compatible.

### D-3 🟠 The verify API reference documents neither `identity_attested` nor any Identity Check field

`https://docs.world.org/world-id/reference/api` fully specifies the v4 verify
endpoint — legacy 3.0, uniqueness 4.0 and session 4.0 request bodies, the success
envelope, `VerifyV4Result`, and the error codes. **Identity Check appears
nowhere.** The only mention of `identity_attested` anywhere in the docs is one
sentence on the credentials page.

Since attribute verification is exactly the thing a backend must not trust the
client for, the server-side contract is the part that most needs specifying. As
an integrator we could not answer, from documentation alone:

- Does `/api/v4/verify/{rp_id}` echo `identity_attested` in its response, or must
  the backend trust the client-side payload?
- Which of the three documented request shapes carries an Identity Check proof?
- Is there a per-attribute breakdown server-side even though the client type is a
  boolean?

We are currently reading `identity_attested` off the IDKit result and
re-verifying the proof separately, which we are not confident is the intended
pattern.

**Ask:** a "verifying Identity Check server-side" section with a real
request/response pair.

### D-4 🟠 Preview access is gated by "contact us", with no self-serve path

The credentials page says only: *"Identity Check is currently in preview. To use
it or learn more, contact us."* No form, no expected turnaround, no note on
whether `staging` works without approval.

For a hackathon this is the difference between building the feature and not.
We de-risked by building against `staging` + the simulator and treating tier 2 as
unreachable until approved — but a beta test that is hard to enter selects for
feedback from teams with existing World contacts.

**Ask:** let `staging` + simulator exercise Identity Check without approval, and
gate only `production`. Even a self-serve form with a stated SLA would help.

### D-5 🟡 Three environments in the types, two in the docs

The result types say (line ~191):

```ts
/** The environment used for this request ("production", "staging", or "sandbox") */
environment: string;
```

The verify API reference documents only `"production" | "staging"` (default
`production`). Nothing explains what `sandbox` is, when to use it, or whether
Identity Check behaves differently there. `environment` is also typed as a bare
`string` here while the API reference treats it as a closed set.

**Ask:** document `sandbox`, and make the field a union type.

### D-6 🟡 Simulator URL is inconsistent across sources

The prize listing points at `https://simulator.orb.engineer/id/0x18d844e5`; the
IDKit docs point at `https://simulator.worldcoin.org/`. We could not tell which
is current, which supports protocol 4.0, or which supports Identity Check
attributes at all. Given D-4, the simulator is the *only* entry point for most
beta testers, so its address should be unambiguous.

**Ask:** one canonical simulator URL in the docs, with a line stating which
protocol versions and presets it supports.

**And the question that actually matters (Q4): can the simulator issue Identity
Check attributes?** We could not find this stated in the docs, on either
simulator page, or in the `worldcoin/simulator` README. The classic simulator
generates synthetic Semaphore identities via an identity faucet — clearly no real
document involved — but whether a *simulated* identity can satisfy
`document_type: passport` + `minimum_age: 18` is undocumented.

This decides whether the document-backed tier is demoable at all without real
documents. We are not willing to scan real passports to test, and we assume no
other beta tester is either. Our design degrades to tier 1 (proof of human) on
staging so the security-critical path is still exercised — but if the simulator
*can* issue attributes, saying so plainly in the docs would remove the single
biggest blocker to testing this feature.

**Partially answered by trying it, not by reading.** Opening
`simulator.orb.engineer` reveals a "Select test identity" screen with a single
synthetic identity — *Identity #0, Verified (All), "Passport • John Doe"*. So
the simulator **does** carry a document-backed credential, which suggests tier 2
is exercisable on staging.

We only found this by opening the tool. Nothing in the Identity Check docs, the
simulator's own landing copy, or the `worldcoin/simulator` README says that a
document credential is available for testing. One sentence — *"the simulator's
test identity holds a passport credential, so Identity Check attribute requests
can be exercised on staging"* — would have saved the entire investigation, and
is exactly what a beta tester needs to know before deciding whether the feature
is testable at all.

Whether attribute *matching* (`document_type: passport`, `minimum_age: 18`)
actually succeeds against this identity is still untested on our side.

### D-7 🟡 `identityCheck()`'s doc comment describes a parameter that does not exist

```ts
/**
 * Creates an IdentityCheck preset for document-based identity attestation.
 * @param params - Identity attribute filters and proof-of-humanity requirement
 */
declare function identityCheck(params: {
    attributes: IdentityAttribute[];
    legacy_signal?: string;
}): IdentityCheckPreset;
```

The comment promises a "proof-of-humanity requirement" parameter; the signature
has none. We spent time looking for how to combine proof-of-human with attribute
checks in one request before concluding it is not expressible (see D-1).

### D-8 🟡 `minimum_age` semantics are unstated

`IdentityAttribute` (line 284) types every attribute as an exact-value filter:

```ts
| { type: "minimum_age"; value: number }
| { type: "issuing_country"; value: string }
```

The name implies `>=`, but the shape is identical to the exact-match attributes
around it, and neither the docs table nor the types say which it is. For an
age-gating integration this is the difference between "18 or older" and "exactly
18". We assumed `>=`; we could not confirm it.

The same ambiguity applies to `issuing_country` / `nationality`: is a single
value an equality test, and is there any way to express "one of {PRT, ESP}"?

### D-9 🔴 Unanswerable from docs: do two credential types share a nullifier for the same app + action?

This is a **question**, not a defect — but we could not answer it from the docs
or the types, and our architecture depends on the answer.

D-1 forces us to split what should be one request into two:

- **enrolment** — `identityCheck({attributes})`, which yields `identity_attested`
  and establishes the assurance tier;
- **per release** — `proofOfHuman({signal: H(package ‖ version ‖ digest)})`,
  which yields the artifact binding that Identity Check cannot.

Joining them requires knowing whether the nullifier is scoped to
`(identity, app, action)` — in which case both requests return the *same*
nullifier and the join is trivial — or to `(identity, app, action, credential
type)`, in which case they return different nullifiers and there is no documented
way to link them.

`ResponseItemV4` carries `identifier` (credential type) *and* `nullifier` per
item, which hints at per-credential scoping, but nothing states it.

We are designing defensively — recording **both** nullifiers at enrolment so the
link holds either way — but that is a guess, and it costs the user an extra scan
during onboarding.

**Ask:** state the nullifier derivation scope explicitly in the docs. If it is
per-credential, a documented way to correlate credentials belonging to one
identity within one app would remove the extra enrolment round-trip entirely.

### D-11 🟠 `hashSignal` exists only as JavaScript — a non-JS backend must reverse-engineer it

To verify a proof server-side you must confirm the returned `signal_hash` matches
the signal you asked for. `idkit-core` ships `hashSignal` (the `./hashing`
export), but our backend is Python, and we could find no specification of the
algorithm in the docs — only the implementation.

We read it out of the published bundle (`dist/hashing.js`):

```js
function hashToField(input) {
  const hash = BigInt("0x" + bytesToHex(keccak_256(input))) >> 8n;
  return hexToBytes(hash.toString(16).padStart(64, "0"));
}
function hashSignal(signal) {
  let input;
  if (signal instanceof Uint8Array)              input = signal;
  else if (signal.startsWith("0x") && isValidHex(signal.slice(2)))
                                                 input = hexToBytes(signal.slice(2));
  else                                           input = new TextEncoder().encode(signal);
  return "0x" + bytesToHex(hashToField(input));
}
```

So: `keccak256(input) >> 8`, rendered as 32 zero-padded bytes — with a
**non-obvious input rule**: a string that merely *looks* like hex is decoded as
bytes rather than encoded as UTF-8. An integrator who assumed UTF-8 always would
produce a mismatching hash for exactly the inputs most likely in a crypto app
(hex digests, addresses), and the failure would look like "the user's proof is
invalid" rather than "your hashing is wrong".

Reimplementing a hash from a minified-adjacent bundle is not a good place for an
integrator to be, and getting it subtly wrong fails closed in a way that is hard
to attribute.

**Ask:** specify `hashSignal` in the docs (one paragraph and the shift-by-8 would
do), or publish it in a language-neutral form. The `>> 8` field reduction and the
hex-detection rule are the two things nobody will guess.

### D-12 🔴 The RP signature scheme is undocumented, and its reference implementation refuses to run outside Node

Every protocol-4.0 request needs an `rp_context` — `rp_id`, `nonce`,
`created_at`, `expires_at` and an ECDSA `signature`. The docs say only that
*"your backend must sign requests to prevent impersonation."* Nothing states
what is signed, over which curve, in what byte order.

Worse, the reference implementation is deliberately Node-only:

```js
if (!isServerEnvironment()) {
  throw new Error("signRequest can only be used in Node.js environments. ...");
}
```

That guard is correct — the signing key must never reach a browser — but it
means a Python/Go/Rust backend has *no* supported path. We had to reimplement
`signRequest` from the published `@worldcoin/idkit-server@1.1.1` bundle:

```
message = version(1 byte = 0x01)
        ‖ nonce(32, itself hashToField(random32))
        ‖ created_at(uint64 big-endian)
        ‖ expires_at(uint64 big-endian)
        ‖ hashToField(utf8(action))        // only when an action is present
digest  = keccak256("\x19Ethereum Signed Message:\n" ‖ len(message) ‖ message)
sig     = secp256k1_sign(digest) → r ‖ s ‖ (recovery + 27)      // 65 bytes
```

Every one of those is a guessable-wrong detail: the version byte, the *two*
separate `hashToField` reductions (nonce and action), big-endian `uint64`
timestamps, EIP-191 framing over a **binary** message, and the `+27` recovery
convention. A wrong offset yields `invalid_rp_signature` with no indication of
which field is wrong.

We verified the port by generating vectors from the real implementation under
node and asserting byte equality of both the message and the digest, then
recovering the signer address. That is a lot of work to stand up something the
protocol requires of *every* integrator.

**Confirmed against real infrastructure.** After provisioning a managed RP
through the Developer Portal MCP (`configure_world_id`), the signature our
Python port produces recovers to exactly the signer address the platform
registered on-chain:

```
registered on-chain signer : 0x685B2FAD1678328901d7fa45F10aB9E83445D3C7
recovered from our sig     : 0x685B2FAD1678328901d7fa45F10aB9E83445D3C7
```

So the reverse-engineering is correct — but that is the point: an integrator
should not have to prove that by experiment.

**Credit where due: the Developer Portal MCP is excellent.** `create_app` →
`configure_world_id` → `create_world_id_action` provisioned a fully registered
RP (on-chain, production *and* staging) in three calls, and
`get_world_id_registration_status` reports sync state per environment. It is by
some distance the smoothest part of this integration. Two notes: the generated
`private_key` is returned once with a clear warning (good), and
`configure_world_id` reports `status: "pending"` while the on-chain registration
settles, which took only seconds — worth documenting the expected wait so
integrators do not poll needlessly or, worse, assume failure.

**Ask:** specify the RP-signature message layout in the docs (the pseudocode
above would be enough), or ship signing helpers for at least one non-JS backend.
Combined with D-11, a non-JS backend currently has to reverse-engineer **two**
undocumented hashing/signing schemes before it can verify anything.

### D-13 🟠 `pollUntilCompletion()` returns an envelope, and the type system cannot stop you posting it

This one cost us a live debugging session, so it is worth stating precisely.

```ts
type IDKitCompletionResult =
  | { success: true;  result: IDKitResult }
  | { success: false; error: IDKitErrorCodes }
```

`/api/v4/verify/{rp_id}` wants `IDKitResult`'s **own** fields at the top level
(`protocol_version`, `nonce`, `action`, `responses`, `user_presence_completed`,
`environment`). Post the envelope instead of `.result` and you get
`validation_error` — with no indication that the *wrapper* is the problem.

The README does show `JSON.stringify(completion.result)`, so the correct usage is
documented. What makes it a trap is that nothing enforces it: the natural backend
signature for a proof is `unknown` or `Record<string, unknown>` (you are about to
forward it verbatim to World, and you have no reason to model its interior), and
**the envelope satisfies both**. So the one place a type checker could catch the
mistake is exactly the place where the type has been widened for good reason. It
type-checks, it runs, and it fails at the far end of a network call as a
validation error about the proof.

The naming compounds it: the envelope's discriminant is `success`, and so is the
verify response's. Two different `success` booleans, one flow.

**Ask:** give the two shapes distinguishable types — a branded `IDKitProof`
returned by `.result`, or a `toVerifyPayload()` / `verifyBody` accessor on the
completion that is the only way to get a postable object. Either makes the
correct call the one that compiles. Failing that, `pollUntilCompletion()` could
return the result directly and surface refusals as a separate channel, since
`success: false` is a *user declining*, not a proof that failed to verify —
conflating those two into one boolean is what puts the envelope on the wire.

### D-14 🟠 `validation_error` names no field

The verify API's rejection for a malformed body is `code: "validation_error"`
with no indication of which field was missing, unexpected, or misshapen.

From the RP's side this is close to unactionable. The word "validation" points at
the *proof* — the natural reading is "the user's credential did not validate" —
when in our case the proof was perfect and the request wrapper was wrong. We
diagnosed it by reading `dist/index.d.ts` and the README, not from the error.

This matters more here than in a typical API, because a protocol-4.0 body is not
hand-written: it is whatever the SDK handed you, forwarded verbatim. When the
server says "that is invalid" and the client says "that is what I was given",
there is no third place to look.

**Ask:** include the offending field path in `detail`, as most validation layers
do by default. `{"code":"validation_error","detail":"responses: field required"}`
would have turned a multi-step investigation into a one-line fix. Distinguishing
"request body malformed" from "proof failed to verify" at the code level would be
even better — they have completely different remedies and completely different
audiences.

> Our own error handling had the same flaw and we fixed it in the same change:
> we were reporting World's `code` and discarding its `detail`. Worth noting that
> an RP will naturally mirror whatever granularity the API offers.

### D-15 🔴 A v3 and a v4 proof from the same identity yield different nullifiers

**Measured, not inferred.** Same app, same `action`, same environment, same
simulator identity, two proofs:

| Proof | Protocol | Nullifier |
|---|---|---|
| Release attestation (Secure Document) | 3.0 | `0x1ef37d4685a77ba08b215704bd8068fe600f18438e5c0c187d96837f7855fe47` |
| Identity Check enrolment | 4.0 | `0x0abf618973bdde8412c0ce87e309b9164466ffcc7a4f0d7039e9efc8f5bbd6d8` |

For any product that uses the nullifier as a **durable pseudonymous identity**,
this is the difference between working and not working. Ours keys publisher
continuity on it: "the last 41 releases of this package were attested by
publisher N, and this one is attested by nobody." If the same human silently
becomes a different N when the proof protocol changes, then every publisher's
history resets and the signal reports a break that did not happen — a false
alarm aimed at the maintainer who did everything right.

It also breaks tier inheritance: we enrol a human once via Identity Check and
look that enrolment up per release by nullifier. Across a protocol boundary the
lookup silently misses, and the publisher is quietly downgraded with no way to
detect that an enrolment ever existed. **There is no observable difference
between "this human never enrolled" and "this human enrolled under the other
protocol"** — they are the same empty result.

Two variables differed here (protocol *and* credential type), so this does not
by itself settle **Q3/D-9**. But whichever variable is responsible, the
practical consequence for an RP is the same and neither is documented.

**Ask:** state the nullifier's derivation scope explicitly — is it
`(identity, app, action)`, or does protocol version and/or credential type
enter it? If it does, say so prominently: any app treating the nullifier as a
stable pseudonym (the documented use for Sybil resistance) is silently wrong the
first time a user's client produces a different proof type. A migration path, or
a way to ask "is this nullifier the same human as that one", would make the
identity usable across the v3→v4 transition instead of resetting at it.

> Our own mitigation is blunt because nothing better is available: legacy proofs
> are refused by default, so identity cannot fragment unless an operator opts in.
> That means an RP must choose between supporting older clients and having a
> durable identity — which is a choice we would rather not have to make.

### D-16 🟢 The Identity Check consent screen is markedly better than the v4 proof screen

Worth reporting as a positive, because the contrast is instructive.

`proofOfHuman` consent reads: *"App will see your: Verification level."*
Identity Check consent reads: *"App will learn **whether**: Age is 18 or older"*,
followed by *"Your underlying document data is not shared."*

The second is the honest description of what a zero-knowledge attribute proof
does, and it is the sentence that makes a user comfortable presenting a passport
to a package registry. The first sounds like data collection and undersells the
protocol — "see your" is exactly the phrasing a privacy-conscious maintainer
recoils from, and it is describing the *more* private of the two exchanges.

**Ask:** carry the "will learn whether" framing and the non-disclosure line into
every preset's consent screen, not just Identity Check.

### D-10 🔵 Version skew between the two published packages

`@worldcoin/idkit@4.2.1` depends on `@worldcoin/idkit-core@4.2.2` — an exact pin
on a *higher* version than the wrapper's own, published ~3 hours earlier. Not
broken, but it makes "which version am I actually on" a question during triage,
and it defeats reading the wrapper's version as the SDK version.

### What worked well

Worth saying plainly, since the rest of this document is problems:

- **The published types are excellent.** Nearly every finding above was
  discoverable by reading `dist/index.d.ts` alone. The doc comments on
  `RpContext`, the error enum and the result types are better than the prose docs.
- **The error taxonomy is unusually good.** `TimestampTooOld`,
  `RpSignatureExpired`, `NullifierReplayed`, `DuplicateNonce`, `InvalidRpSignature`
  are exactly the failures an RP-signed flow actually hits, and they are
  distinguishable — we could branch on codes instead of matching message strings.
- **RP signing is the right default.** `RpContext` forcing `rp_id` + `nonce` +
  `created_at`/`expires_at` + signature means the "anyone can impersonate your
  app" failure mode is closed by construction rather than by a docs warning.
- **`require_user_presence` is exactly the primitive our threat model needs**, and
  the response echoing `user_presence_completed` means a backend can verify it
  rather than assume it. This is the single feature that makes an anti-worm
  attestation possible at all — please keep it verifiable server-side.

---

## Why we request these attributes, and how we minimize

Required by the prize, and it is also the honest summary of our design.

| Attribute | Requested? | Why |
|---|---|---|
| `document_type` | yes | Assurance tier. A document-backed credential makes a throwaway publisher identity expensive to farm, which is the entire economics of the attack we defend against. |
| `minimum_age` (18) | yes | Establishes a legally accountable adult accepting a duty of care over code that runs on millions of machines. |
| `issuing_country` | **opt-in only, default off** | Only for enterprise consumers with jurisdiction requirements. Never required to publish. |
| `nationality` | **never** | No use in our threat model. |
| `full_name` | **never** | Would defeat the design (below). |
| `document_number` | **never** | Would defeat the design (below). |

**The minimization is structural, not a policy promise.** The publisher identity
we store is the **nullifier** — a per-app, per-action pseudonym that is stable for
a person and linkable to nothing outside our app. That is *sufficient* for
continuity: we only ever need to answer "is this the same human as last release?"
Learning *who* they are would add nothing to the security property and would
create a real-name registry of open-source maintainers, which is a target.

What we persist: the nullifier, the tier, and per-attribute **boolean assertions**
(`minimum_age>=18: true`) — never attribute values. Attestation envelopes go to
public, immutable decentralized storage, so this is enforced by a test asserting
no identity-attribute *value* can reach the envelope serializer, not by review.

---

## User feedback — protocol

**Status: defined, sessions pending.** Recording it here so the method is fixed
before we see results.

**Participants:** ≥5, all people who have published to npm. Recruited at the
venue. No World App experience required — first-time install is a case we care
about, since maintainer adoption depends on it.

**Task:** "You maintain this package. Attest release 1.2.3 so your users can tell
it came from you." No further instruction — we want to see whether the flow
explains itself.

**Instrumented funnel.** Measured from the engine's durable event log, not
self-reported:

```
session.created → ownership.verified → idkit.opened
   → proof.returned → verify.ok → chain.recorded
```

Per-step drop-off and wall-clock timings. The step we most expect to lose people
at is `idkit.opened → proof.returned` — first-time World App install plus a
document scan, inside a CLI-initiated flow.

**Comprehension questions,** asked after the task, before any explanation:

1. What did you just prove to NpmGuard?
2. What does NpmGuard now know about you? *(the real test of whether the
   nullifier's pseudonymity was communicated — if people believe we learned their
   name, the consent screen has failed even though the data was never sent)*
3. Would you do this for every release? If not, at what frequency?
4. What would you expect to happen if someone stole your npm token tomorrow?

**Consent:** we record whether participants noticed *what* was being requested
before scanning, and whether they could state what they consented to afterwards.

**Results table** — to be filled in:

| # | npm exp. | World App before? | Furthest step | Total time | Q2 answered correctly |
|---|---|---|---|---|---|
| _pending_ | | | | | |

---

## Reproducing the developer findings

```bash
npm pack @worldcoin/idkit-core@4.2.2
tar xzf worldcoin-idkit-core-4.2.2.tgz
grep -n "identity_attested\|IdentityCheckPreset\|legacy_signal" package/dist/index.d.ts
grep -n "signal?: string" package/dist/index.d.ts   # present on 8 of 9 presets
```
