-- 0009: M3 slice 2 — the review transitions (SPEC §5.1 T8–T12, T14; §5.2; CONSTRAINTS I4, I5).
-- referral_transitions is the only way the app role moves a referral between statuses: one immutable row per
-- transition, checked against the referral's current status under a row lock, which then moves the status and
-- writes the audit row in the same statement. A direct status UPDATE by codex_app is refused.
--   T8  ready_for_review -> on_hold          note
--   T9  ready_for_review -> info_requested   requested fact keys (>= 1); keys only, never free text
--   T10 ready_for_review -> escalated        department and note
--   T11 on_hold | info_requested | escalated -> ready_for_review   note
--   T12 ready_for_review -> finalized        the referral's original decision, by the same user
--   T14 draft -> ready_for_review            manual entry: no documents, at least one evaluation (engineering
--                                            default 2026-10-29, founder to confirm)
-- Notes are free text a Reviewer writes, like a fact note: PHI-capable, short purge class (§9), never in an
-- event or an audit row. Not here (next slice): T13 amend and the co-sign flow.

CREATE FUNCTION transition_items_ok(items text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(items) <= 20
     AND NOT EXISTS (SELECT 1 FROM unnest(items) i WHERE i IS NULL OR i !~ '^[a-z][a-z0-9_]{0,63}$')
$$;

CREATE TABLE referral_transitions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id      uuid NOT NULL,
  referral_id      uuid NOT NULL,
  transition       text NOT NULL,
  from_status      referral_status NOT NULL,
  to_status        referral_status NOT NULL,
  note             text CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)),
  department       text CHECK (department IS NULL OR department IN ('administrator', 'director_of_nursing', 'medical_director', 'business_office', 'therapy', 'social_services')),
  requested_items  text[] NOT NULL DEFAULT '{}' CHECK (transition_items_ok(requested_items)),
  decision_id      uuid,
  created_by       text NOT NULL CHECK (created_by ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|platform:[a-z0-9_]{1,63})$'),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (facility_id, referral_id) REFERENCES referrals (facility_id, id),
  FOREIGN KEY (facility_id, referral_id, decision_id) REFERENCES decisions (facility_id, referral_id, id),
  CONSTRAINT referral_transitions_shape CHECK (CASE transition
    WHEN 'T8'  THEN from_status = 'ready_for_review' AND to_status = 'on_hold' AND note IS NOT NULL
    WHEN 'T9'  THEN from_status = 'ready_for_review' AND to_status = 'info_requested' AND cardinality(requested_items) >= 1
    WHEN 'T10' THEN from_status = 'ready_for_review' AND to_status = 'escalated' AND department IS NOT NULL AND note IS NOT NULL
    WHEN 'T11' THEN from_status IN ('on_hold', 'info_requested', 'escalated') AND to_status = 'ready_for_review' AND note IS NOT NULL
    WHEN 'T12' THEN from_status = 'ready_for_review' AND to_status = 'finalized' AND decision_id IS NOT NULL
    WHEN 'T14' THEN from_status = 'draft' AND to_status = 'ready_for_review'
    ELSE false END),
  CONSTRAINT referral_transitions_fields CHECK (
    (decision_id IS NULL) = (transition <> 'T12')
    AND (department IS NULL) = (transition <> 'T10')
    AND (cardinality(requested_items) = 0) = (transition <> 'T9'))
);

CREATE FUNCTION referral_transitions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status referral_status;
BEGIN
  NEW.created_at := clock_timestamp();
  -- the app role acts only as a Reviewer or Admin of this facility
  IF current_user = 'codex_app' AND NOT (NEW.created_by LIKE 'user:%' AND EXISTS (
       SELECT 1 FROM user_facility_roles
       WHERE user_id = substr(NEW.created_by, 6)::uuid AND facility_id = NEW.facility_id AND role IN ('facility_admin', 'admissions_reviewer'))) THEN
    RAISE EXCEPTION 'referral_transitions: actor % may not move referrals here', NEW.created_by USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO current_status FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id FOR UPDATE;
  IF current_status IS DISTINCT FROM NEW.from_status THEN
    RAISE EXCEPTION 'referral_transitions: referral is %, not %', current_status, NEW.from_status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.transition = 'T12' AND NOT EXISTS (
       SELECT 1 FROM decisions d
       WHERE d.facility_id = NEW.facility_id AND d.referral_id = NEW.referral_id AND d.id = NEW.decision_id
         AND d.amends_decision_id IS NULL AND 'user:' || d.decided_by::text = NEW.created_by) THEN
    RAISE EXCEPTION 'referral_transitions: T12 must name the original decision, made by the finalizer' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.transition = 'T14' AND (
       EXISTS (SELECT 1 FROM documents WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id)
       OR NOT EXISTS (SELECT 1 FROM evaluations WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id)) THEN
    RAISE EXCEPTION 'referral_transitions: T14 needs no documents and at least one evaluation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION referral_transitions_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE referrals SET status = NEW.to_status, updated_at = now() WHERE facility_id = NEW.facility_id AND id = NEW.referral_id;
  INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id)
  VALUES (NEW.facility_id, NEW.created_by, CASE NEW.transition
      WHEN 'T8' THEN 'referral.held' WHEN 'T9' THEN 'referral.info_requested' WHEN 'T10' THEN 'referral.escalated'
      WHEN 'T11' THEN 'referral.resumed' WHEN 'T12' THEN 'referral.finalized' WHEN 'T14' THEN 'referral.submitted_for_review' END,
    'referral', NEW.referral_id);
  RETURN NULL;
END
$$;

-- The app role's status changes come only from the transition trigger above (trigger depth 2), never directly.
CREATE FUNCTION referrals_app_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'codex_app' AND NEW.status IS DISTINCT FROM OLD.status AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'referrals: codex_app moves a referral only through referral_transitions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER referral_transitions_guard BEFORE INSERT ON referral_transitions FOR EACH ROW EXECUTE FUNCTION referral_transitions_guard();
CREATE TRIGGER referral_transitions_apply AFTER INSERT ON referral_transitions FOR EACH ROW EXECUTE FUNCTION referral_transitions_apply();
CREATE TRIGGER referral_transitions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON referral_transitions FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
CREATE TRIGGER referrals_app_status_guard BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION referrals_app_status_guard();
ALTER TABLE referral_transitions ENABLE ALWAYS TRIGGER referral_transitions_guard;
ALTER TABLE referral_transitions ENABLE ALWAYS TRIGGER referral_transitions_apply;
ALTER TABLE referral_transitions ENABLE ALWAYS TRIGGER referral_transitions_immutable;
ALTER TABLE referrals ENABLE ALWAYS TRIGGER referrals_app_status_guard;

ALTER TABLE referral_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referral_transitions USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

GRANT SELECT, INSERT ON referral_transitions TO codex_app;
REVOKE UPDATE, DELETE, TRUNCATE ON referral_transitions FROM codex_app, codex_worker;
-- the app never sets any referral column directly any more except through the trigger above
REVOKE UPDATE ON referrals FROM codex_app;
GRANT UPDATE (status, updated_at) ON referrals TO codex_app;
