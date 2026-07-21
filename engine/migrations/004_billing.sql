-- Freemium billing state. A GitHub App installation is the billing account:
-- organization members share one plan and cannot each consume a separate free
-- allowance for the same repositories.

CREATE TABLE billing_accounts (
  installation_id INTEGER PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE account_usage (
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                    -- 'YYYY-MM'
  audits INTEGER NOT NULL DEFAULT 0,      -- newly enqueued, uncached package versions
  PRIMARY KEY (installation_id, month)
);

-- Preserve beta usage where the organization login still maps to an active
-- installation. Future accounting uses the stable installation id.
INSERT OR IGNORE INTO account_usage (installation_id, month, audits)
SELECT i.id, ou.month, ou.audits
FROM org_usage ou
JOIN installations i ON i.account_login = ou.org;
