-- Preserve review edits separately from observed session boundaries.
ALTER TABLE development_session ADD COLUMN proposed_started_at timestamptz;
