-- 0012: M3 slice 5 — document intake (SPEC §5.1 T1, T4, T5, T6; §8 referral_type; §12.1 data flow;
-- dev-alignment 1.3, 1.4, 3.5).
--   * referrals.referral_type: skilled by default (engineering default; the MVP set is founder item 11);
--   * documents by the app role: inserted only as 'uploaded', only on a referral staff may still add to, at most
--     20 per referral, each with an audit row; the object itself was size- and magic-byte-checked by the API
--     before it left quarantine;
--   * T1 draft -> processing (submit; >= 1 uploaded document), T4 partial_failure -> processing (a failed
--     document was replaced), T5 partial_failure -> ready_for_review (no document left failed or unreadable;
--     each was marked not_applicable with a reason), T6 review states -> processing (a document was added).

ALTER TABLE referrals ADD COLUMN referral_type text NOT NULL DEFAULT 'skilled'
  CHECK (referral_type IN ('skilled', 'long_term', 'bed_hold_readmission', 'respite', 'hospice'));

CREATE FUNCTION documents_app_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st referral_status;
BEGIN
  IF current_user <> 'codex_app' THEN
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id FOR UPDATE;
  IF st NOT IN ('draft', 'ready_for_review', 'on_hold', 'info_requested', 'escalated', 'partial_failure') THEN
    RAISE EXCEPTION 'documents: a document cannot be added to a % referral', st USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'uploaded' OR NEW.pages IS NOT NULL OR NEW.not_applicable_reason IS NOT NULL THEN
    RAISE EXCEPTION 'documents: the app inserts a document as uploaded, with nothing the pipeline reports' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM documents WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id) >= 20 THEN
    RAISE EXCEPTION 'documents: at most 20 documents per referral' USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER documents_app_insert_guard BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION documents_app_insert_guard();
ALTER TABLE documents ENABLE ALWAYS TRIGGER documents_app_insert_guard;

-- T1, T4, T5, T6 on the transitions table
ALTER TABLE referral_transitions DROP CONSTRAINT referral_transitions_shape;
ALTER TABLE referral_transitions ADD CONSTRAINT referral_transitions_shape CHECK (CASE transition
    WHEN 'T1'  THEN from_status = 'draft' AND to_status = 'processing'
    WHEN 'T4'  THEN from_status = 'partial_failure' AND to_status = 'processing'
    WHEN 'T5'  THEN from_status = 'partial_failure' AND to_status = 'ready_for_review'
    WHEN 'T6'  THEN from_status IN ('ready_for_review', 'on_hold', 'info_requested', 'escalated') AND to_status = 'processing'
    WHEN 'T8'  THEN from_status = 'ready_for_review' AND to_status = 'on_hold' AND note IS NOT NULL
    WHEN 'T9'  THEN from_status = 'ready_for_review' AND to_status = 'info_requested' AND cardinality(requested_items) >= 1
    WHEN 'T10' THEN from_status = 'ready_for_review' AND to_status = 'escalated' AND department IS NOT NULL AND note IS NOT NULL
    WHEN 'T11' THEN from_status IN ('on_hold', 'info_requested', 'escalated') AND to_status = 'ready_for_review' AND note IS NOT NULL
    WHEN 'T12' THEN from_status = 'ready_for_review' AND to_status = 'finalized' AND decision_id IS NOT NULL
    WHEN 'T13' THEN from_status IN ('finalized', 'amended') AND to_status = 'amended' AND decision_id IS NOT NULL
    WHEN 'T14' THEN from_status = 'draft' AND to_status = 'ready_for_review'
    ELSE false END);
ALTER TABLE referral_transitions DROP CONSTRAINT referral_transitions_fields;
ALTER TABLE referral_transitions ADD CONSTRAINT referral_transitions_fields CHECK (
    (decision_id IS NULL) = (transition NOT IN ('T12', 'T13'))
    AND (note IS NULL OR transition IN ('T8', 'T9', 'T10', 'T11'))
    AND (department IS NULL) = (transition <> 'T10')
    AND (cardinality(requested_items) = 0) = (transition <> 'T9'));

CREATE OR REPLACE FUNCTION referral_transitions_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  current_status referral_status;
BEGIN
  NEW.created_at := clock_timestamp();
  IF current_user = 'codex_app' AND (NEW.created_by IS DISTINCT FROM 'user:' || app_user()::text OR NOT EXISTS (
       SELECT 1 FROM user_facility_roles
       WHERE user_id = app_user() AND facility_id = NEW.facility_id AND role IN ('facility_admin', 'admissions_reviewer'))) THEN
    RAISE EXCEPTION 'referral_transitions: actor % may not move referrals here', NEW.created_by USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO current_status FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id FOR UPDATE;
  IF current_status IS DISTINCT FROM NEW.from_status THEN
    RAISE EXCEPTION 'referral_transitions: referral is %, not %', current_status, NEW.from_status USING ERRCODE = 'check_violation';
  END IF;
  -- T1, T4, T6 hand the referral to the pipeline: there must be a document for it to process
  IF NEW.transition IN ('T1', 'T4', 'T6') AND NOT EXISTS (
       SELECT 1 FROM documents WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id AND status = 'uploaded') THEN
    RAISE EXCEPTION 'referral_transitions: % needs a document waiting to be processed', NEW.transition USING ERRCODE = 'check_violation';
  END IF;
  -- T5: every failed or unreadable document was marked not_applicable (with its reason, 0003 CHECK)
  IF NEW.transition = 'T5' AND EXISTS (
       SELECT 1 FROM documents WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id AND status IN ('failed', 'unreadable', 'uploaded')) THEN
    RAISE EXCEPTION 'referral_transitions: T5 needs every failed document marked not applicable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.transition IN ('T12', 'T13') AND NOT EXISTS (
       SELECT 1 FROM decisions d
       WHERE d.facility_id = NEW.facility_id AND d.referral_id = NEW.referral_id AND d.id = NEW.decision_id
         AND (d.amends_decision_id IS NULL) = (NEW.transition = 'T12')
         AND NEW.created_by IN ('user:' || d.decided_by::text, 'user:' || d.cosigned_by::text)
         AND d.id = (SELECT l.id FROM decisions l WHERE l.facility_id = NEW.facility_id AND l.referral_id = NEW.referral_id ORDER BY l.decided_at DESC LIMIT 1)
         AND d.evaluation_id = (SELECT e.id FROM evaluations e WHERE e.facility_id = NEW.facility_id AND e.referral_id = NEW.referral_id
                                ORDER BY e.evaluated_at DESC LIMIT 1)) THEN
    RAISE EXCEPTION 'referral_transitions: % must name the referral''s latest decision (an original for T12, an amendment for T13), made by the finalizer on the latest evaluation', NEW.transition USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.transition = 'T14' AND (
       EXISTS (SELECT 1 FROM documents WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id)
       OR NOT EXISTS (SELECT 1 FROM evaluations WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id)) THEN
    RAISE EXCEPTION 'referral_transitions: T14 needs no documents and at least one evaluation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION referral_transitions_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE referrals SET status = NEW.to_status, updated_at = now()
  WHERE facility_id = NEW.facility_id AND id = NEW.referral_id AND status = NEW.from_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'referral_transitions: referral is no longer %', NEW.from_status USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id)
  VALUES (NEW.facility_id, NEW.created_by, CASE NEW.transition
      WHEN 'T1' THEN 'referral.submitted_for_processing' WHEN 'T4' THEN 'referral.reprocessing'
      WHEN 'T5' THEN 'referral.failures_resolved' WHEN 'T6' THEN 'referral.document_added'
      WHEN 'T8' THEN 'referral.held' WHEN 'T9' THEN 'referral.info_requested' WHEN 'T10' THEN 'referral.escalated'
      WHEN 'T11' THEN 'referral.resumed' WHEN 'T12' THEN 'referral.finalized' WHEN 'T13' THEN 'referral.amended'
      WHEN 'T14' THEN 'referral.submitted_for_review' END,
    'referral', NEW.referral_id);
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION referral_transitions_apply() FROM PUBLIC;

-- every function in public pins search_path (grants.sql reports any that does not)
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f);
  END LOOP;
END
$$;
