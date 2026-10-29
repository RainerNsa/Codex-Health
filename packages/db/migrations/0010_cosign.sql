-- 0010: M3 slice 3 — the second-Admin co-sign (SPEC §5.1 T12, §6; CONSTRAINTS I4, I5; open question 24).
-- A decision that needs a co-sign (a hard stop overridden to Admit; any decision after a flipped hard-stop
-- input) is made in two requests by two people:
--   1. the decider files a decision_requests row (their decision, on the latest evaluation, with its reason);
--   2. a different Admin co-signs it in their own request: the decisions row names the request, the decider
--      as decided_by and the co-signer as cosigned_by, and the co-signer's T12 row finalizes the referral.
-- Who is acting: the API binds app.user_id per transaction (like app.facility_id). For codex_app every actor
-- column checked here must equal it, so one API request can never write two people's names (security review of
-- PR #24, finding 4). This catches API mistakes; a compromised app role can rebind the setting, so identity
-- itself rests on authentication. Amendments by the app role are refused until T13 ships with its own checks.

CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE TABLE decision_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id      uuid NOT NULL,
  referral_id      uuid NOT NULL,
  evaluation_id    uuid NOT NULL,
  decision         outcome NOT NULL CHECK (decision <> 'needs_review'),
  override_reason  text CHECK (override_reason IS NULL OR (btrim(override_reason) <> '' AND length(override_reason) <= 500)),
  requested_by     uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (facility_id, referral_id, id),
  FOREIGN KEY (facility_id, referral_id) REFERENCES referrals (facility_id, id),
  FOREIGN KEY (facility_id, referral_id, evaluation_id) REFERENCES evaluations (facility_id, referral_id, id)
);

CREATE FUNCTION decision_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ev evaluations%ROWTYPE;
BEGIN
  NEW.created_at := clock_timestamp();
  IF current_user = 'codex_app' AND NEW.requested_by IS DISTINCT FROM app_user() THEN
    RAISE EXCEPTION 'decision_requests: requested_by must be the acting user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_facility_roles WHERE user_id = NEW.requested_by AND facility_id = NEW.facility_id AND role IN ('facility_admin', 'admissions_reviewer')) THEN
    RAISE EXCEPTION 'decision_requests: requester holds no Reviewer or Admin role here' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT status FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id FOR UPDATE) IS DISTINCT FROM 'ready_for_review' THEN
    RAISE EXCEPTION 'decision_requests: the referral is not ready_for_review' USING ERRCODE = 'check_violation';
  END IF;
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

CREATE FUNCTION decision_requests_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id)
  VALUES (NEW.facility_id, 'user:' || NEW.requested_by::text, 'decision.cosign_requested', 'decision_request', NEW.id);
  RETURN NULL;
END
$$;

CREATE TRIGGER decision_requests_guard BEFORE INSERT ON decision_requests FOR EACH ROW EXECUTE FUNCTION decision_requests_guard();
CREATE TRIGGER decision_requests_audit AFTER INSERT ON decision_requests FOR EACH ROW EXECUTE FUNCTION decision_requests_audit();
CREATE TRIGGER decision_requests_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON decision_requests FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
ALTER TABLE decision_requests ENABLE ALWAYS TRIGGER decision_requests_guard;
ALTER TABLE decision_requests ENABLE ALWAYS TRIGGER decision_requests_audit;
ALTER TABLE decision_requests ENABLE ALWAYS TRIGGER decision_requests_immutable;
ALTER TABLE decision_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON decision_requests USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);
GRANT SELECT, INSERT ON decision_requests TO codex_app;
REVOKE UPDATE, DELETE, TRUNCATE ON decision_requests FROM codex_app, codex_worker;

-- A co-signed decision names the request it carries out.
ALTER TABLE decisions ADD COLUMN decision_request_id uuid;
ALTER TABLE decisions ADD CONSTRAINT decisions_request_fk
  FOREIGN KEY (facility_id, referral_id, decision_request_id) REFERENCES decision_requests (facility_id, referral_id, id);

CREATE OR REPLACE FUNCTION decisions_app_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  req decision_requests%ROWTYPE;
BEGIN
  IF current_user <> 'codex_app' THEN
    RETURN NEW;
  END IF;
  IF NEW.amends_decision_id IS NOT NULL THEN
    RAISE EXCEPTION 'decisions: amendments arrive with T13' USING ERRCODE = 'feature_not_supported';
  END IF;
  IF (SELECT status FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id) IS DISTINCT FROM 'ready_for_review' THEN
    RAISE EXCEPTION 'decisions: an original decision needs the referral in ready_for_review' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.cosigned_by IS NULL THEN
    -- a decision without a co-sign is the acting user's own, and carries no request
    IF NEW.decided_by IS DISTINCT FROM app_user() OR NEW.decision_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'decisions: decided_by must be the acting user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- a co-signed decision: the acting user is the co-signer, carrying out a request the decider filed earlier
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
     OR EXISTS (SELECT 1 FROM decision_requests n WHERE n.facility_id = req.facility_id AND n.referral_id = req.referral_id AND n.created_at > req.created_at) THEN
    RAISE EXCEPTION 'decisions: a co-signed decision must carry out the latest request by the decider, unchanged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- T12: the app's actor is the acting user, and is the decider or (for a co-signed decision) the co-signer.
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
  IF NEW.transition = 'T12' AND NOT EXISTS (
       SELECT 1 FROM decisions d
       WHERE d.facility_id = NEW.facility_id AND d.referral_id = NEW.referral_id AND d.id = NEW.decision_id
         AND d.amends_decision_id IS NULL
         AND NEW.created_by IN ('user:' || d.decided_by::text, 'user:' || d.cosigned_by::text)
         AND d.evaluation_id = (SELECT e.id FROM evaluations e WHERE e.facility_id = NEW.facility_id AND e.referral_id = NEW.referral_id
                                ORDER BY e.evaluated_at DESC LIMIT 1)) THEN
    RAISE EXCEPTION 'referral_transitions: T12 must name the original decision, made by the finalizer on the latest evaluation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.transition = 'T14' AND (
       EXISTS (SELECT 1 FROM documents WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id)
       OR NOT EXISTS (SELECT 1 FROM evaluations WHERE facility_id = NEW.facility_id AND referral_id = NEW.referral_id)) THEN
    RAISE EXCEPTION 'referral_transitions: T14 needs no documents and at least one evaluation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

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
