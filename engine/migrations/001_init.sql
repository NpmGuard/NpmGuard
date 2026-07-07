-- Panel foundation schema (spec: docs/specs/2026-07-07-github-repo-panel.md).
-- The DB stores everything that is NOT a report — reports stay on disk under
-- data/reports/ with report-store.ts as the single source of truth.
-- package_verdicts below is a derived, rebuildable index of that store.

-- GitHub identities that signed in. id = GitHub user id.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Opaque 32-byte-hex session tokens, HttpOnly cookie on the client.
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- GitHub App installations. id = GitHub installation id.
CREATE TABLE installations (
  id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,             -- 'Organization' | 'User'
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Which installations a user can access (cached from GET /user/installations,
-- refreshed on dashboard loads). Authorization checks read this table.
CREATE TABLE user_installations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  refreshed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, installation_id)
);

-- Repos visible through an installation. id = GitHub repo id.
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT NOT NULL DEFAULT 'main',
  protected_at TEXT,                      -- NULL = Protect off
  lockfile_path TEXT,                     -- discovered at last scan
  lockfile_sha TEXT,                      -- blob sha, drift check for reconcile
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_repos_installation ON repos(installation_id);

-- The dependency index: normalized lockfile contents per repo. This is the
-- substrate registry-watch alerts from — keep it fresh (webhooks + reconcile).
CREATE TABLE repo_deps (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  direct INTEGER NOT NULL DEFAULT 0,
  range TEXT,                             -- declared range (direct deps only)
  PRIMARY KEY (repo_id, name, version)
);
CREATE INDEX idx_repo_deps_name ON repo_deps(name);

-- One row per repo scan (manual audit, push delta, reconcile, watch-triggered).
CREATE TABLE scans (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL,             -- 'manual' | 'push' | 'reconcile'
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'done' | 'failed'
  total INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  audited INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  check_run_id INTEGER,                   -- GitHub check run (push-triggered scans)
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX idx_scans_repo ON scans(repo_id, started_at);

-- The exact (pkg, version) set a scan covers. Progress and check conclusions
-- compute from this — not from repo_deps, which can move under a live scan
-- (another push) and which delta scans deliberately don't touch.
CREATE TABLE scan_items (
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  cached INTEGER NOT NULL DEFAULT 0,      -- verdict existed before this scan
  PRIMARY KEY (scan_id, name, version)
);
CREATE INDEX idx_scan_items_pkg ON scan_items(name, version);

-- Durable audit-job queue. Survives restarts (spec §5.4).
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                     -- 'audit_package'
  lane TEXT NOT NULL DEFAULT 'cheap',     -- 'cheap' | 'deep' (reserved)
  org TEXT,                               -- account_login, for round-robin fairness
  scan_id INTEGER REFERENCES scans(id) ON DELETE SET NULL,
  package_name TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',   -- 'queued' | 'running' | 'done' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_state ON jobs(state, lane, created_at);
CREATE INDEX idx_jobs_scan ON jobs(scan_id);
CREATE UNIQUE INDEX idx_jobs_active_pkg ON jobs(package_name, version)
  WHERE state IN ('queued', 'running');

-- Derived index of data/reports/ for fast rollups. Rebuildable at any time;
-- report files remain authoritative.
CREATE TABLE package_verdicts (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  verdict TEXT NOT NULL,
  audited_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

-- Registry-watch state: every distinct package used by a protected repo.
CREATE TABLE watched_packages (
  name TEXT PRIMARY KEY,
  etag TEXT,
  known_versions TEXT NOT NULL DEFAULT '[]',  -- JSON array of semver strings
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Beta soft caps: audits enqueued per org per month (spec decision 9).
CREATE TABLE org_usage (
  org TEXT NOT NULL,
  month TEXT NOT NULL,                    -- 'YYYY-MM'
  audits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org, month)
);

-- Dashboard alert feed (registry-watch findings, dangerous push verdicts).
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  org TEXT NOT NULL,
  repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  package_name TEXT NOT NULL,
  version TEXT NOT NULL,
  verdict TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- 'watch' | 'push' | 'manual'
  message TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_alerts_org ON alerts(org, created_at);
