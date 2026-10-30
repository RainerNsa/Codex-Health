-- 0014: M4 slice 1 — the worker evaluates a referral itself after extraction (SPEC §14.2 raw evaluation), so it
-- reads the rule set and facility profile, under the same row-level security as the API, and writes neither.
GRANT SELECT ON rule_sets, facility_profiles TO codex_worker;

-- What a person stated is never replaced by the pipeline: the database refuses it too, not only the worker's code.
CREATE FUNCTION facts_worker_keeps_user_facts() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'codex_worker' AND EXISTS (
       SELECT 1 FROM facts f WHERE f.facility_id = NEW.facility_id AND f.id = NEW.supersedes AND f.source = 'user') THEN
    RAISE EXCEPTION 'codex_worker may not supersede a fact a person stated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER facts_worker_keeps_user_facts BEFORE INSERT ON facts FOR EACH ROW EXECUTE FUNCTION facts_worker_keeps_user_facts();
ALTER TABLE facts ENABLE ALWAYS TRIGGER facts_worker_keeps_user_facts;
