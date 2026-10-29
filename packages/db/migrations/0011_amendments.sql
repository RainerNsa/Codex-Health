-- 0011: M3 slice 4 — amendments (SPEC §5.1 T13; §5.2; decision 11; CONSTRAINTS I4, I5).
-- An Admin amends a finalized (or already amended) referral with a new decision record and a reason; the
-- original decision is never touched (0003 keeps decisions immutable). The amendment names the latest
-- decision and the latest evaluation (0003 decisions_guard). An amendment that needs a co-sign under the
-- same rules as an original decision (an Admit after any hard stop; any decision after a flipped hard-stop
-- input) is filed as a decision_requests row carrying the amendment, and a different Admin carries it out.
-- T13 moves the referral to amended; every amendment by the app role carries its T13 row by commit.
-- The facts stay frozen after finalize: an amendment corrects the decision on the recorded evaluation.

-- --- requests can carry an amendment ------------------------------------------------------------------------
ALTER TABLE decision_requests ADD COLUMN amends_decision_id uuid;
ALTER TABLE decision_requests ADD COLUMN amendment_reason text;
ALTER TABLE decision_requests ADD CONSTRAINT decision_requests_amends_fk
  FOREIGN KEY (facility_id, referral_id, amends_decision_id) REFERENCES decisions (facility_id, referral_id, id);
ALTER TABLE decision_requests ADD CONSTRAINT decision_requests_amendment_pair CHECK (
  (amends_decision_id IS NULL) = (amendment_reason IS NULL)
  AND (amendment_reason IS NULL OR (btrim(amendment_reason) <> '' AND length(amendment_reason) <= 500)));

CREATE OR REPLACE FUNCTION decision_requests_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ev evaluations%ROWTYPE;
  st referral_status;
BEGIN
  IF current_user = 'codex_app' AND NEW.requested_by IS DISTINCT FROM app_user() THEN
    RAISE EXCEPTION 'decision_requests: requested_by must be the acting user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_facility_roles WHERE user_id = NEW.requested_by AND facility_id = NEW.facility_id
                 AND role IN ('facility_admin', 'admissions_reviewer')
                 AND (NEW.amends_decision_id IS NULL OR role = 'facility_admin')) THEN
    RAISE EXCEPTION 'decision_requests: requester may not decide this here (amendments are Admin only)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO st FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id FOR UPDATE;
  IF NEW.amends_decision_id IS NULL AND st IS DISTINCT FROM 'ready_for_review' THEN
    RAISE EXCEPTION 'decision_requests: the referral is not ready_for_review' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amends_decision_id IS NOT NULL AND (st NOT IN ('finalized', 'amended') OR NEW.amends_decision_id IS DISTINCT FROM (
       SELECT d.id FROM decisions d WHERE d.facility_id = NEW.facility_id AND d.referral_id = NEW.referral_id ORDER BY d.decided_at DESC LIMIT 1)) THEN
    RAISE EXCEPTION 'decision_requests: an amendment names the latest decision of a finalized referral' USING ERRCODE = 'check_violation';
  END IF;
  -- stamped after the referral lock, so "the latest request" follows commit order
  NEW.created_at := clock_timestamp();
  SELECT * INTO ev FROM evaluations WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id ORDER BY evaluated_at DESC LIMIT 1;
  IF ev.id IS DISTINCT FROM NEW.evaluation_id THEN
    RAISE EXCEPTION 'decision_requests: the evaluation is not the latest' USING ERRCODE = 'check_violation';
  END IF;
  -- I5: a reason exactly when the decision differs from the recommendation
  IF (NEW.decision <> ev.outcome) IS DISTINCT FROM (NEW.override_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'decision_requests: an override reason is required exactly when the decision differs' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- --- decisions by the app role: originals from ready_for_review, amendments from finalized/amended ------------
CREATE OR REPLACE FUNCTION decisions_app_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  req decision_requests%ROWTYPE;
  st referral_status;
BEGIN
  IF current_user <> 'codex_app' THEN
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id;
  IF NEW.amends_decision_id IS NULL AND st IS DISTINCT FROM 'ready_for_review' THEN
    RAISE EXCEPTION 'decisions: an original decision needs the referral in ready_for_review' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amends_decision_id IS NOT NULL AND st NOT IN ('finalized', 'amended') THEN
    RAISE EXCEPTION 'decisions: an amendment needs a finalized referral' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.cosigned_by IS NULL THEN
    IF NEW.decided_by IS DISTINCT FROM app_user() OR NEW.decision_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'decisions: decided_by must be the acting user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.cosigned_by IS DISTINCT FROM app_user() THEN
    RAISE EXCEPTION 'decisions: cosigned_by must be the acting user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO req FROM decision_requests
  WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id AND id = NEW.decision_request_id;
  IF req.id IS NULL
     OR req.requested_by IS DISTINCT FROM NEW.decided_by
     OR req.evaluation_id IS DISTINCT FROM NEW.evaluation_id
     OR req.decision IS DISTINCT FROM NEW.decision
     OR req.override_reason IS DISTINCT FROM NEW.override_reason
     OR req.amends_decision_id IS DISTINCT FROM NEW.amends_decision_id
     OR req.amendment_reason IS DISTINCT FROM NEW.amendment_reason
     OR EXISTS (SELECT 1 FROM decision_requests n WHERE n.facility_id = req.facility_id AND n.referral_id = req.referral_id AND n.created_at > req.created_at) THEN
    RAISE EXCEPTION 'decisions: a co-signed decision must carry out the latest request by the decider, unchanged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- every app decision carries its transition by commit: T12 for an original, T13 for an amendment
CREATE OR REPLACE FUNCTION decisions_finalized_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM referral_transitions t
       WHERE t.facility_id = NEW.facility_id AND t.decision_id = NEW.id
         AND t.transition = CASE WHEN NEW.amends_decision_id IS NULL THEN 'T12' ELSE 'T13' END) THEN
    RAISE EXCEPTION 'decisions: decision % was never finalized or amended (no T12/T13 row)', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- --- T13 on the transitions table ---------------------------------------------------------------------------
ALTER TABLE referral_transitions DROP CONSTRAINT referral_transitions_shape;
ALTER TABLE referral_transitions ADD CONSTRAINT referral_transitions_shape CHECK (CASE transition
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
    AND (note IS NULL OR transition NOT IN ('T12', 'T13', 'T14'))
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
  IF NEW.transition IN ('T12', 'T13') AND NOT EXISTS (
       SELECT 1 FROM decisions d
       WHERE d.facility_id = NEW.facility_id AND d.referral_id = NEW.referral_id AND d.id = NEW.decision_id
         AND (d.amends_decision_id IS NULL) = (NEW.transition = 'T12')
         AND NEW.created_by IN ('user:' || d.decided_by::text, 'user:' || d.cosigned_by::text)
         -- the referral's latest decision, on its latest evaluation
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
      WHEN 'T8' THEN 'referral.held' WHEN 'T9' THEN 'referral.info_requested' WHEN 'T10' THEN 'referral.escalated'
      WHEN 'T11' THEN 'referral.resumed' WHEN 'T12' THEN 'referral.finalized' WHEN 'T13' THEN 'referral.amended'
      WHEN 'T14' THEN 'referral.submitted_for_review' END,
    'referral', NEW.referral_id);
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION referral_transitions_apply() FROM PUBLIC;

-- one T12/T13 per decision: T13 (amended -> amended) could otherwise be replayed on an existing amendment
-- (security review of PR #26)
CREATE UNIQUE INDEX referral_transitions_one_per_decision ON referral_transitions (facility_id, decision_id) WHERE decision_id IS NOT NULL;

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
