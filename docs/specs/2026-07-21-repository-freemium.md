# Repository Free/Pro decision

## Product boundary

The billing account is a GitHub App installation. Every member who can access
the same installation sees and consumes the same allowance, so reinstalling
or adding users does not multiply the free tier.

| Resource | Free | Pro default |
|---|---:|---:|
| Protected repositories | 3 | 25 |
| New package-version audits per calendar month | 250 | 5,000 |
| Cached package verdicts | Unlimited | Unlimited |

Limits are configuration, not hard-coded product constants. A limit of `0`
means unlimited. The recurring price is deliberately not recorded here: it
must be chosen commercially, then configured with
`NPMGUARD_STRIPE_PRO_PRICE_ID`.

## What consumes the audit allowance

A repository scan resolves its dependency snapshot against NpmGuard's shared
verdict cache. Only package/version pairs that are absent from the cache and
actually enter the audit queue consume the installation's monthly allowance.
Repeated scans of unchanged or already-known dependencies are free.

## Paywall behavior

- Existing protected repositories remain protected when the limit is reached.
- Enabling Protect on another repository opens the upgrade dialog.
- A scan that needs more new audits than remain opens the same dialog before
  work is queued.
- Stripe Checkout collects payment details. NpmGuard grants Pro only after a
  signed Stripe webhook records an `active` or `trialing` subscription.
- Stripe Billing Portal manages cancellation and payment method changes.

## Demo safety and false-positive policy

Repository checks fail only for `DANGEROUS` results backed by admitted sandbox
reproduction evidence or the narrow deterministic shell-pipe rule. Static
signals that still need reproduction are `SUSPECT`; incomplete audits are
`UNKNOWN`. Both remain visible to the user but do not block a pull request.

This split protects the demo from presenting uncertainty as a confirmed
attack while keeping suspicious evidence visible for investigation.
