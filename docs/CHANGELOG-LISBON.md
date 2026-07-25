# NpmGuard — ETHGlobal Lisbon changelog

Dated log of work done during the Lisbon hackathon window, for the
**Continuity** track submission requirements.

## Prior state

The work below builds on NpmGuard as it existed before the hackathon:

| | |
|---|---|
| Commit | `67f830f772f876cba053d97b889533dab8475adf` |
| Dated | `2026-07-25T13:27:17+02:00` |
| Subject | `sensors: parse what the producers actually emit, and enforce that with a lint` |

Everything after that commit is Lisbon-window work.

At that commit NpmGuard was: an npm supply-chain audit engine (LLM + Docker
sandbox pipeline producing evidence-bound `SAFE / ERROR / DANGEROUS` verdicts),
a CLI that gates `npm install`, a GitHub panel, and payments via Stripe +
a Solidity contract on Base Sepolia. It had **no** 0G integration and **no**
identity layer of any kind.

---

## Target networks

Hackathon posture: **testnet wherever a testnet exists and is usable.**

| Subsystem | Network | Endpoint |
|---|---|---|
| 0G Chain — contracts, audit payment settlement | **Galileo testnet, chain id `16602`** | `https://evmrpc-testnet.0g.ai` · explorer `https://chainscan-galileo.0g.ai` · faucet `https://faucet.0g.ai` |
| 0G Storage — attestation envelopes, report mirror | **Galileo testnet** | indexer `https://indexer-storage-testnet-turbo.0g.ai` |
| 0G Compute — audit inference | **mainnet router** (forced — see 2026-07-25 finding) | `https://router-api.0g.ai/v1` |
| World ID | **staging** + simulator | `https://developer.world.org/api/v4` |

---

## 2026-07-25 — Phase 0: spikes

Four unknowns the docs did not settle, probed live before writing any code.

### ✅ 0G Compute Router is reachable and self-describing

`GET https://router-api.0g.ai/v1/models` answers **unauthenticated** with 23
models and unusually rich metadata: `supported_parameters`, `context_length`,
`max_completion_tokens`, `pricing_usd`, and per-model TEE fields
(`verifiability`, `tee_attested`, `tee_type`, `tee_verifier`).

The decisive result: **`deepseek-v4-flash` is available on 0G, TEE-attested
(TDX / dstack), and lists `response_format` in `supported_parameters`.** That is
the *same model family the audit pipeline already runs* on OpenRouter, so
inference can move onto 0G without re-tuning prompts or re-measuring transports.

Candidate chain for the audit roles (all TEE-attested, all advertise
`response_format` + `tools`):

| Model | ctx | $/Mtok in | $/Mtok out | Role |
|---|---|---|---|---|
| `deepseek-v4-flash` | 1M | 0.121 | 0.242 | primary (all roles) |
| `qwen3.7-plus` | 1M | 0.221 | 0.881 | structured fallback |
| `glm-5.2` | 1M | 0.900 | 3.000 | investigation fallback |

### ⚠️ FINDING — inference cannot run on 0G testnet

`GET https://router-api-testnet.integratenetwork.work/v1/models` returns
**exactly 2 models**: `qwen-image-edit` and `qwen2.5-omni`. Neither is usable
for a code-audit pipeline.

**Consequence:** 0G Compute inference must point at the **mainnet** router while
contracts, settlement and storage stay on Galileo testnet. This is not a
compromise of the testnet posture — the Router is a metered service with its own
balance, independent of where our contracts live — but it does mean the router
account needs real 0G. At `deepseek-v4-flash` pricing a full audit costs on the
order of a cent.

Network selection is therefore **per subsystem** in config, not one global flag.

### ⚠️ CORRECTION — Galileo chain id is `16602`, not `16601`

Widely-repeated third-party sources (and 0G's own relaunch announcement) say
`16601`. The live chain disagrees:

```
$ curl -sX POST https://evmrpc-testnet.0g.ai -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
{"jsonrpc":"2.0","id":1,"result":"0x40da"}      # 0x40da == 16602
```

Independently confirmed by the official Python SDK, which hardcodes
`"chain_id": 16602` with the comment *"Official Galileo testnet chain ID"*.
Mainnet checks out as documented: `0x4115` == `16661`.

### ✅ 0G Storage is reachable from Python — no Node sidecar needed

The plan assumed Go/TypeScript only and budgeted a Node sidecar. There is in
fact an **official Python SDK**: `0g-storage-sdk` (PyPI), source
`github.com/0glabs/0g-py-sdk`, v0.4.0 (2026-05-18). It is a faithful port of the
TS SDK and exposes `Indexer`, `ZgFile`, `Uploader`, `Downloader`, `MerkleTree`
and `KvClient` (0G Storage KV). Its dependencies (`web3>=7.14`, `eth-account`,
`pycryptodome`, `requests`) are compatible with the engine, which already
depends on `web3>=7`.

The indexer also exposes both a JSON-RPC API and a REST file gateway at
`GET /file?root=…` (verified: HTTP 200).

**Caveat, carried as a risk:** the SDK installs top-level modules
`config.py`, `core/`, `utils/`, `models/`, `contracts/`, `exceptions.py`
*directly into site-packages* rather than under a namespace package. Any
dependency doing a bare `import config` / `import models` would be shadowed.
Mitigation: install it, then run the full engine suite immediately; if anything
breaks, move it behind an isolated venv + subprocess sidecar. The engine's own
code is unaffected (it uses relative imports throughout).

### ◐ TEE attestation — partially resolved

Per-model TEE metadata (`tee_attested: true`, `tee_type: "TDX"`,
`tee_verifier: "dstack"`, `verifiability: "TeeML"`) is available from `/models`
with no key, so it can be recorded against every audit immediately.

Whether the per-response `ZG-Res-Key` header (the chat id used to verify the
enclave's ECDSA signature over the response) survives the Router as opposed to a
direct provider connection is **still unverified** — it needs an authenticated
call. Handled as: record it when present, omit when absent, and never claim
verifiable inference for a call that lacks it.

---

## 2026-07-25 — Phase 1: audit inference runs on 0G Compute

`NPMGUARD_LLM_BACKEND=zerog` now points the entire audit pipeline — intent,
flag, hypothesis, propose, agent, judge — at the 0G Compute Router.

**`ZeroGAdapter`** (`engine/kit_llm/provider.py`). A thin subclass of the
existing `OpenAICompatAdapter`, the same way `OpenRouterAdapter` already is. It
reads the enclave chat id from the `ZG-Res-Key` response header and lands it in
`provider_call_id` — which is already what that column means, so Sealed
Inference verification data is captured with **no schema migration**. Calls
without the header degrade to an ordinary OpenAI-compatible call and carry no
verifiability claim. Adding it required one new hook on the base adapter
(`_create`), so no adapter duplicates `complete()`.

**Per-backend model profiles** (`engine/npmguard/llm_runtime.py`). The reasoning
knobs, fallback tails and static prices were keyed on OpenRouter slugs at module
scope. They now live in a `_Profile` record selected by backend — configuration,
not a new seam. The 0G profile is built from what the Router itself advertises:
`qwen3.7-plus` / `glm-5.2` (advertise `response_format`) back the structured
roles; `minimax-m3` (advertises `tools` but not `response_format`) is agent-role
only, the same split the OpenRouter profile already makes for `cohere/north-mini`.
Static prices are carried for every 0G route because the Router reports token
usage but never cost — an unpriced route would bill at the deliberately
expensive fallback rate and make the budget gate meaningless.

Reasoning is disabled only for `deepseek-v4-flash`, where the existing OpenRouter
profile measured it. The other 0G routes are deliberately left absent rather than
guessed.

**Regression discipline.** OpenRouter remains the default and its exact shipped
chain — slugs, order, transports, zero-pinned `:free` prices — is now pinned by
`tests/test_llm_runtime_backends.py::test_openrouter_chain_is_unchanged_by_the_profile_split`.

**Caught by the fixtures, as designed.** The first version of this change
selected role models via pydantic's `model_fields_set` ("was this explicitly
configured?"). The replay-slice harness sets bundle models with
`object.__setattr__`, which bypasses that bookkeeping — so replay silently ran
the profile default instead of the bundle's recorded model and all four
committed audits failed to reproduce. Replaced with explicit
`zerog_triage_model` / `zerog_investigation_model` settings: a model name is a
knob, and the knob a route reads must name a model that route's catalogue
serves. The prompt-hash-pinned fixtures failed loud exactly as `engine/TESTING.md`
promises they would.

**Suite:** `605 passed`, up from a `589 passed` baseline (+4 replay slices
restored, +12 new). The 16 remaining failures are pre-existing and
environment-specific — `tests/test_stub_proxy.py` and
`tests/test_instrumentation_l4.py` spawn `node` with a hardcoded
`PATH=/usr/bin:/bin:/usr/local/bin`, which omits Apple Silicon Homebrew's
`/opt/homebrew/bin`. Verified identical on a clean tree at `67f830f`.

---

## 2026-07-25 — Phase 2: settlement and the attestation registry on 0G Chain

**`NpmGuardAttestations.sol`** (new). The append-only registry of human-attested
releases. A row binds a World ID nullifier (the durable, pseudonymous publisher
identity) to one exact tarball digest, an assurance tier, and the 0G Storage
root of the evidence envelope. Writes are restricted to an owner-managed
verifier allowlist, because a World proof cannot be checked on-chain — the row
is the verifier's statement that it checked one off-chain.

The central invariant: **no revoke, no overwrite.** If history could be
rewritten, an attacker reaching the verifier key could retroactively manufacture
a clean publisher streak, and the continuity signal would be worthless. Keys use
`abi.encode` rather than `abi.encodePacked`, so no `(name, version)` pair can
collide into another release's slot — both properties are pinned by tests.

**0G Chain settlement.** `payments.py`'s `_chain()` if/else became a `CHAINS`
table; `0g-testnet` (16602) and `0g` (16661) are rows in it. The receipt fetch,
event decode, `(package, version)` match and exactly-once claim are untouched —
a test verifies a 0G payment through that identical path, which is what makes
"a chain is a table row" a checkable claim rather than a comment.

`/config/public` now returns a `chains[]` array, with the legacy single-chain
`crypto` field preserved so already-published CLIs keep working. The CLI's
hardcoded `BASE_SEPOLIA_CHAIN_ID` (in five places, plus a bundled contract
address) is now a chain registry resolved against what the engine reports —
the engine's address wins, since trusting a stale bundled constant could send a
real payment to a contract the engine will not verify against. Added
`npmguard install --chain <name>`; with several chains configured and no flag,
the CLI prompts.

Chains are declared with viem's `defineChain` rather than imported from
`viem/chains`, so support for a chain never depends on which viem release is
installed.

**Deploy tooling.** `./deploy.sh [sepolia|mainnet|0g-testnet|0g] [audit|attestations]`.
`--verify` is skipped on 0G: chainscan is not an Etherscan-compatible
verification API and passing the flag fails the whole broadcast.

**Suite:** contracts `18 passed` (8 existing + 10 new, fuzz at 256 runs each);
engine `609 passed`; frontend typecheck clean + `294 passed`.

**Not yet done:** neither contract is deployed. That needs a funded Galileo
wallet (faucet: `faucet.0g.ai`), so the addresses below are still blank.

| Contract | Network | Address |
|---|---|---|
| `NpmGuardAuditRequest` | 0G Galileo testnet (16602) | _pending deploy_ |
| `NpmGuardAttestations` | 0G Galileo testnet (16602) | _pending deploy_ |
| `NpmGuardAuditRequest` | Base Sepolia (84532) | `0xBF562626e4Afb883423Ec719e0270DB232bcB9eD` (pre-existing) |

---

## 2026-07-25 — Phase 3: 0G Storage

`npmguard/zerog/storage.py` — content-addressed JSON put/get over the official
Python SDK (`0g-storage-sdk`), so the Node sidecar the plan budgeted was not
needed. Objects are canonicalized with **RFC 8785** before upload (`rfc8785` was
already an engine dependency), which makes the root hash a function of the
*value* rather than of key order or float spelling: a third party who
re-serializes the same object gets the same root and can prove the stored bytes
are the ones we quote.

**FINDING — the SDK silently discards the signer.** `Indexer.upload(file, rpc,
signer, ...)` accepts a `signer`, but `new_uploader_from_indexer_nodes` never
forwards it and `Uploader.upload_file` reads the signing account from
`opts['account']` instead. The SDK's own default opts do not set that key, so the
documented call shape always dies deep in the upload with a bare "account is
None". Passing `upload_opts` also replaces the defaults wholesale, so every key
the uploader reads has to be re-supplied. Both are pinned by a test.

**Report mirror** (`NPMGUARD_ZEROG_MIRROR_REPORTS`, off by default). Finished
reports can be published to 0G Storage as a public, tamper-evident copy. Three
invariants, each with a test:

- it runs **after** the terminal SSE frame — a storage network is never between a
  computed verdict and its delivery;
- a mirror failure can never fail an audit;
- unconfigured means no storage call at all.

The second one was a real bug caught by its own test: `try_put_json` is
contractually non-raising, but `_mirror_report` was *relying* on that. A raising
mirror escaped into `_execute`'s outer handler, which tried to finalize an
already-`done` row and turned a completed audit into a lifecycle assertion.
`_mirror_report` now lets nothing escape.

**Packaging hazard, accepted knowingly:** `0g-storage-sdk` installs top-level
`config.py`, `core/`, `utils/`, `models/`, `contracts/` and `exceptions.py`
directly into site-packages rather than under a namespace package. Verified after
installing that nothing in the engine is shadowed (all engine code is namespaced
under `npmguard.*` / `kit_*`) and the suite is unchanged. Worth re-checking if a
future dependency does a bare `import models`.

---

## 2026-07-25 — Inference switch

`NPMGUARD_LLM_BACKEND` is now a one-variable preset in both directions, so a demo
can move between providers by editing a single line:

```
NPMGUARD_LLM_BACKEND=openrouter   # the pre-0G setup
NPMGUARD_LLM_BACKEND=zerog        # 0G Compute, TEE-attested
```

Each preset resolves its own endpoint, model catalogue, fallback tail and
adapter; `OPENROUTER_API_KEY` / `ZEROG_API_KEY` are honoured as fallbacks so both
keys can sit in `.env` and flipping needs no key edit. `openai_compatible`
remains the escape hatch for any other endpoint.

One trap avoided: the `claude-*` → `anthropic/claude-*` slug rewrite was keyed on
the backend being spelled `openai_compatible`, so a new `openrouter` value would
have silently sent bare slugs that OpenRouter rejects. That check now follows the
resolved route, not the backend name.

**Suite:** engine `627 passed` (16 pre-existing node-PATH failures unchanged).

---

## 2026-07-25 — Phase 4 (part 1): the World ID trust boundary

`npmguard/attestations.py` — the server-side half of publisher attestation.
Mirrors the rule `payments.py` already enforces for money: the client collects,
the server decides. The CLI opens a browser and the browser talks to World App;
neither is trusted about what was proven.

**Every publish requires a fresh human proof.** The per-release proof is
`proofOfHuman` with `require_user_presence`, bound to one exact tarball:

```
signal = "npmguard:v1:<package>@<version>:<integrity>:<github_user_id>"
```

The engine recomputes that signal from its own session state and rejects any
proof whose `signal_hash` disagrees — so a proof minted for `lodash@4.17.21` is
worthless for any other artifact, and one obtained in one authenticated session
cannot be replayed by a different signed-in user. Nothing on the maintainer's
machine (npm token, CI secret, GitHub token, or a worm holding all three) can
produce it.

The document-backed **tier** is established once at enrolment and looked up by
nullifier, because it is a durable property of the *human*, not of the release —
re-scanning a passport per release proves nothing new, and (finding D-1) could
not be bound to the artifact anyway.

**Ported World's `hashSignal` to Python.** It ships only as JavaScript and is
unspecified in the docs (finding D-11). Read out of the published bundle:
`keccak256(input) >> 8`, rendered as 32 zero-padded bytes, with a non-obvious
input rule — a string that merely *looks* like hex is decoded as bytes rather
than encoded as UTF-8. The port is pinned against **seven vectors generated by
running the real `idkit-core@4.2.2` implementation under node**, including the
three cases that separate hex-decoding from UTF-8 (`0xdeadbeef` → bytes,
`0xZZZ` → UTF-8 because invalid hex, `0xabc` → UTF-8 because odd length). All
seven match.

**Refusals, each with a test.** A proof is refused when: World says failure; the
`signal_hash` is for another artifact; there is **no** `signal_hash` at all (an
unbound proof authorizes everything — the shape an IdentityCheck proof would
have); the action differs (another nullifier namespace); fresh user presence is
missing; or no nullifier came back. There is no partial acceptance.

**Data minimization is enforced by the serializer, not by review.** The envelope
published to 0G Storage carries per-attribute **booleans**
(`{"minimum_age>=18": true}`) and the nullifier — never attribute values. A
parametrized test asserts that each of `full_name`, `document_number`,
`nationality`, `issuing_country` and `document_type` is rejected outright.

**Staging is self-describing.** The envelope records which World environment
produced it, and `world_is_production` is exposed so every surface can say so. A
staging attestation carries no real-world assurance and must never be
presentable as though it did — and since the record is immutable, it has to
carry that fact itself.

Whole feature is gated behind a computed `world_enabled` (app id + rp id +
signing key), exactly like `github_app_enabled`: unset means the engine behaves
precisely as it does today.

**Suite:** engine `656 passed` (+29). 16 pre-existing node-PATH failures.

---

## 2026-07-25 — Phase 4 (part 2): the attestation flow, end to end

**Ownership** (`attest_ownership.py`). World ID proves a human is present; it
says nothing about *which* packages they may speak for. That second question is
answered by resolving the package's own `repository` field to `owner/repo` and
requiring **push** access for the signed-in GitHub user. Read access is
explicitly not enough — anyone can read a public repo, so accepting it would let
any GitHub user attest any public package.

**State** (`attest_tables.py`, `attest_store.py`, migration `0007`). Sessions are
short-lived; attestations are append-only and unique on `(package, version)`, so
a second attestation is a conflict rather than an overwrite — local state can
never disagree with the on-chain registry. The signal is frozen on the session
at *ownership* time, so verification always compares against what the server
decided, never against anything the client later sends.

**Routes** (`attest_routes.py`): open a session → prove ownership → fetch the
IDKit config → submit the proof. Gated behind `world_enabled` exactly like the
panel is gated behind `github_app_enabled`.

**Ported World's RP-signature scheme to Python.** Protocol 4.0 requires a signed
`rp_context` on every request, and the scheme is undocumented — worse, the
reference implementation *refuses to run outside Node* by design (finding D-12).
Reimplemented from the `@worldcoin/idkit-server@1.1.1` bundle: a bespoke binary
message (version byte ‖ field-reduced nonce ‖ two big-endian `uint64`
timestamps ‖ `hashToField(action)`), hashed EIP-191 style, signed secp256k1 with
`v = recovery + 27`. Verified by generating vectors from the real implementation
under node and asserting **byte equality of both the message and the digest**,
then recovering the signer address.

**CLI** — `npmguard attest <pkg>@<version>` opens a session, opens the browser
and polls. It holds no key and verifies nothing; it prints the tier, and prints
a loud warning whenever the environment is not production.

**Frontend** — `pages/Attest.tsx`, a three-step flow with the IDKit widget lazily
imported so its WASM bundle never loads on any other route. A **STAGING banner**
renders whenever the environment is not production: a staging proof carries no
real-world assurance, and the screen must never let one read as though it did.

**Suite:** engine `672 passed`; frontend typecheck clean, `294 passed`,
production build OK. 16 pre-existing node-PATH failures.
