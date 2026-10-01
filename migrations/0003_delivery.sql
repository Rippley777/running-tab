ALTER TABLE delivery_outbox ADD COLUMN locked_at timestamptz;
CREATE INDEX delivery_pending ON delivery_outbox(state,created_at);
