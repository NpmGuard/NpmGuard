-- Read-only, user-triggered audits for public GitHub repositories that are
-- not installed in the NpmGuard GitHub App. These snapshots deliberately do
-- not join `repos`: they cannot be protected, receive webhooks, or own checks.

CREATE TABLE public_repo_scans (
  id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  github_repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL COLLATE NOCASE,
  html_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  commit_sha TEXT,
  lockfile_path TEXT NOT NULL,
  lockfile_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'done'
  total INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  audited INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX idx_public_repo_scans_installation
  ON public_repo_scans(installation_id, started_at DESC);
CREATE UNIQUE INDEX idx_public_repo_scans_active
  ON public_repo_scans(installation_id, full_name)
  WHERE status = 'running';

CREATE TABLE public_repo_scan_items (
  scan_id INTEGER NOT NULL REFERENCES public_repo_scans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  direct INTEGER NOT NULL DEFAULT 0,
  range TEXT,
  cached INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scan_id, name, version)
);
CREATE INDEX idx_public_repo_scan_items_pkg
  ON public_repo_scan_items(name, version);
