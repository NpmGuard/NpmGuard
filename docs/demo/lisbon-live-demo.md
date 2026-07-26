# The live demo: publishing `eth-global-lisbon`

The judge-facing walkthrough (`axios-walkthrough.html`) tells the axios story on
slides. This runbook reproduces that story **live, against the public npm
registry**, with a package the presenter genuinely owns.

Everything here uses the real path: a real publish to npmjs.org, a real GitHub
push-access check, a real World ID proof bound to the real tarball digest.

- package — <https://www.npmjs.com/package/eth-global-lisbon>
- repo — <https://github.com/PiotrTyrakowski/eth-global-lisbon> (working copy at
  `~/repos/eth-global-lisbon`)

## Why there is a setup phase

The obvious script — *install an unattested package, watch it warn* — does not
work, and it is important to understand that this is the design rather than a
gap.

A package nobody has ever attested reports `NO_HISTORY`, and the CLI prints
**nothing** (`attest_index.py:189`, `install.ts:164`). Almost all of npm is
unattested. A warning that fires on everything is one people learn to scroll
past, which costs nothing right up until the day it is correct.

The signal is not *"this is unattested"*. It is *"this **broke a streak** of
attestations"*, and a streak needs `DEFAULT_STREAK_THRESHOLD = 3` consecutive
attested releases before an unattested one counts as a break.

So the setup phase is not scaffolding around the demo. It **is** the demo: it
builds the publisher history that makes the break legible.

## Before the room

Both are one-time.

```bash
npm login                      # the presenter's own npm account; nobody else can do this
export NPMGUARD_API_URL=http://localhost:8000
```

Engine on `:8000`, frontend on `:3002`, signed in to the panel with GitHub.

Confirm the ownership bypass is **off** — with it on, the attest page cheerfully
reports "push access confirmed" for `axios`, which is exactly the claim a judge
will test:

```bash
grep NPMGUARD_ATTEST_DEV_TRUST_OWNERSHIP engine/.env   # must be false
```

## Setup: build the streak (~10 min, do it before presenting)

Three times — `1.0.1`, `1.0.2`, `1.0.3`:

```bash
cd ~/repos/eth-global-lisbon
./release.sh                                    # test, bump, publish, tag
npmguard attest eth-global-lisbon@<version>     # opens the attest page
```

On the page: **Continue with GitHub** → **Prove with World ID** → copy the link
into <https://simulator.orb.engineer>.

Verify the history landed before you stop:

```bash
npmguard install eth-global-lisbon
#   ✓ Publisher human-attested (3 in a row)
```

## The demo

**1 — "I own this package."** Show npmjs.org/package/eth-global-lisbon, then the
repo. Same person. Then show the tool refusing a package you *don't* own: start
`npmguard attest axios@1.14.1`, click through GitHub, and it answers
`you do not have push access to axios/axios`. The check is real, and it is worth
proving that before asking anyone to trust the green case.

**2 — the attested install.**

```bash
npmguard install eth-global-lisbon
#   ✓ Publisher human-attested (3 in a row)
```

**3 — publish without attesting.** This is the account-takeover moment: the
tarball is fine, the version is fine, nobody proved they meant it.

```bash
./release.sh minor          # 1.1.0, published, NOT attested
npmguard install eth-global-lisbon@1.1.0
#   PUBLISHER BREAK
#   The previous 3 releases were attested by the same publisher. This one is
#   attested by nobody — the pattern an account takeover or a self-replicating
#   worm produces.
```

Say the honest thing out loud here: **it prompts, it does not block.** NpmGuard
removes the silence, not the choice.

**4 — attest it, and the same command goes quiet.**

```bash
npmguard attest eth-global-lisbon@1.1.0     # World proof
npmguard install eth-global-lisbon@1.1.0
#   ✓ Publisher human-attested (4 in a row)
```

## What is deliberately not claimed

- We do not stop `npm publish`. The proof is bound to a tarball digest, so it
  cannot exist before the tarball does.
- Staging World credentials carry no real-world assurance, and the page says so
  on every screen. Do not let a staging proof be presented as a real one.
- The document (Identity Check) enrolment is one-time — not a convenience, but
  because World's IdentityCheck preset accepts no `signal` and therefore cannot
  be bound to an artifact at all. Per-release liveness is the load-bearing part
  and is never skipped.

## If something breaks live

| Symptom | Cause |
|---|---|
| attest page: `declares no GitHub repository` | `repository` missing from the published package.json — it is only read from the **packument**, so it must be in the published version |
| attest page: `you do not have push access` on your own repo | signed in to the panel as a different GitHub account |
| `npmguard install` prints nothing about publishers | `NO_HISTORY` — the streak is not built yet |
| CLI hits npmguard.com instead of localhost | `NPMGUARD_API_URL` not exported in that shell |
| World: `Production request detected` | `NPMGUARD_WORLD_ENVIRONMENT` is not `staging` |
