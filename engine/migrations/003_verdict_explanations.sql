ALTER TABLE package_verdicts
  ADD COLUMN reason TEXT NOT NULL DEFAULT '';

ALTER TABLE package_verdicts
  ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 0;
