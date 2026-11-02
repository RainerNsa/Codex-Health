-- 0019: rate limits every API process shares. One row per facility and budget, reset in place, so the table holds at most a few
-- rows per member. Ids and counts only: `bucket` is a budget name and a user id. No foreign key: a counter outlives nothing it refers to.
CREATE TABLE rate_limits (
  facility_id uuid NOT NULL,
  bucket      text NOT NULL CHECK (length(bucket) <= 64),
  started_at  timestamptz NOT NULL DEFAULT now(),
  hits        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (facility_id, bucket)
);
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rate_limits
  USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON rate_limits TO codex_app;
