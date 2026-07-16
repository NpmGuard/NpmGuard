-- Cache whether the default branch currently has a supported root lockfile.
-- lockfile_path NULL + auditability_checked_at NOT NULL = confirmed non-auditable.
ALTER TABLE repos ADD COLUMN auditability_checked_at TEXT;
