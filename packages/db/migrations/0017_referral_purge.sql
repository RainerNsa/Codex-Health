-- 0017: the deletion job's first half (SPEC §9; decision log 2026-11-02). services/worker/src/purge.ts deletes a closed
-- referral's short-class data as the owner, bound to one facility. Decisions, evaluations and the audit chain stay. Their
-- free text (override and amendment reasons) waits on counsel (F10), so nothing here touches those tables' immutability.
--
-- Transition notes are short purge class (0009) yet immutable, and grants.sql holds that immutability. They stay until a
-- founder and counsel decide how to reconcile the two (decision log 2026-11-02), through a constraints-change.

-- purge_started_at claims the referral before any file goes, so nothing can change it while the job runs.
ALTER TABLE referrals ADD COLUMN purge_started_at timestamptz, ADD COLUMN purged_at timestamptz;

-- A referral being purged takes no new data from anyone, so an amendment cannot rest on facts that are gone.
CREATE FUNCTION refuse_purged_referral() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM referrals r WHERE r.facility_id = NEW.facility_id AND r.id = NEW.referral_id AND r.purge_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'referral has been purged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER refuse_purged_referral BEFORE INSERT ON facts FOR EACH ROW EXECUTE FUNCTION refuse_purged_referral();
CREATE TRIGGER refuse_purged_referral BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION refuse_purged_referral();
CREATE TRIGGER refuse_purged_referral BEFORE INSERT ON evaluations FOR EACH ROW EXECUTE FUNCTION refuse_purged_referral();
CREATE TRIGGER refuse_purged_referral BEFORE INSERT ON decisions FOR EACH ROW EXECUTE FUNCTION refuse_purged_referral();
CREATE TRIGGER refuse_purged_referral BEFORE INSERT ON decision_requests FOR EACH ROW EXECUTE FUNCTION refuse_purged_referral();
ALTER TABLE facts ENABLE ALWAYS TRIGGER refuse_purged_referral;
ALTER TABLE documents ENABLE ALWAYS TRIGGER refuse_purged_referral;
ALTER TABLE evaluations ENABLE ALWAYS TRIGGER refuse_purged_referral;
ALTER TABLE decisions ENABLE ALWAYS TRIGGER refuse_purged_referral;
ALTER TABLE decision_requests ENABLE ALWAYS TRIGGER refuse_purged_referral;

-- Opening a closed referral writes a product event. Refusing it would break the page, so for a purged referral it is dropped.
CREATE FUNCTION drop_purged_event() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM referrals r WHERE r.facility_id = NEW.facility_id AND r.id = NEW.referral_id AND r.purge_started_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER drop_purged_event BEFORE INSERT ON product_events FOR EACH ROW EXECUTE FUNCTION drop_purged_event();
ALTER TABLE product_events ENABLE ALWAYS TRIGGER drop_purged_event;
