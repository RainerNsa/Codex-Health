-- 0007: one root assertion per fact key per referral (security review of M2 slice 3). facts_insert_guard reads
-- "the latest assertion" without a lock, and facts_one_successor_per_fact (0005) covers only rows that supersede,
-- so two concurrent FIRST entries for a key both passed and forked the lineage: two current assertions, and every
-- later correction refused. Every assertion after the first must supersede (0003), so a key has exactly one row
-- with supersedes NULL; this makes the database refuse the second root. The API also serialises fact writes per
-- referral with a row lock, so a client sees 409 rather than a refusal in the normal case.
-- A forked lineage already in the table is not resolved here: which assertion is current is a reviewer's call,
-- not a migration's. Stop with a clear message instead (counts only, no ids or values).
DO $$
DECLARE forks bigint;
BEGIN
  SELECT count(*) INTO forks FROM (
    SELECT 1 FROM facts WHERE supersedes IS NULL GROUP BY facility_id, referral_id, key HAVING count(*) > 1) f;
  IF forks > 0 THEN
    RAISE EXCEPTION '0007: % fact lineage(s) already have two root assertions; reconcile them before migrating', forks;
  END IF;
END
$$;
CREATE UNIQUE INDEX facts_one_root_per_key ON facts (facility_id, referral_id, key) WHERE supersedes IS NULL;
