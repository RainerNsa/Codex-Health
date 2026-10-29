-- 0005: fixes from the consolidated review of 0002–0004 (decision log 2026-10-29), before the API writes
-- decisions at M3.
--   a. evaluated_at and decided_at are pinned by the triggers: they drive the "latest" rules, so a writer
--      could pick which evaluation counts or fork an amendment chain by choosing a timestamp.
--   b. Amendment and supersession chains cannot fork: one amendment per decision, one successor per fact.
--   c. facts.created_by takes the 0004 actor shapes (user:<uuid>, worker:<job id>); a name no longer fits.
--   d. platform actors accept any role name Postgres accepts in lowercase, so provisioning cannot fail on a
--      role called codex_admin2 or a 40-character name.
--   e. user_facility_roles (the privilege table behind decided_role/cosigned_role): a user may only hold a
--      role at a facility of their own organisation, and every grant or revoke writes an audit row on the
--      facility chain. Only the owner may write it today; this lands before any app grant does.
--   f. documents: a not_applicable_reason rewrite without a status change was unaudited and unguarded; the
--      reason may only change together with the status.

-- a. ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION evaluations_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'codex_app' AND NEW.raw THEN
    RAISE EXCEPTION 'codex_app may not write a raw evaluation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.evaluated_at := clock_timestamp();   -- never writer-chosen: "latest" is decided by append order
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ev evaluations%ROWTYPE;
  latest_decision uuid;
BEGIN
  NEW.decided_at := clock_timestamp();     -- never writer-chosen
  SELECT * INTO ev FROM evaluations e WHERE e.facility_id = NEW.facility_id AND e.id = NEW.evaluation_id;
  IF ev.id IS NULL THEN
    RAISE EXCEPTION 'decision: evaluation % is not visible for facility %', NEW.evaluation_id, NEW.facility_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF ev.outcome <> NEW.recommended_outcome OR ev.referral_id <> NEW.referral_id THEN
    RAISE EXCEPTION 'decision: recommended_outcome or referral does not match evaluation %', NEW.evaluation_id USING ERRCODE = 'check_violation';
  END IF;
  NEW.recommended_clinical_outcome := ev.clinical_outcome;
  IF EXISTS (SELECT 1 FROM evaluations n WHERE n.facility_id = NEW.facility_id AND n.referral_id = NEW.referral_id AND n.evaluated_at > ev.evaluated_at) THEN
    RAISE EXCEPTION 'decision: evaluation % is not the latest for referral %', NEW.evaluation_id, NEW.referral_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.role INTO NEW.decided_role FROM user_facility_roles r
  WHERE r.facility_id = NEW.facility_id AND r.user_id = NEW.decided_by AND r.role IN ('facility_admin', 'admissions_reviewer')
  ORDER BY (r.role = 'facility_admin') DESC LIMIT 1;
  IF NEW.decided_role IS NULL THEN
    RAISE EXCEPTION 'decision: user % holds no Reviewer or Admin role at facility %', NEW.decided_by, NEW.facility_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.cosigned_by IS NOT NULL THEN
    SELECT r.role INTO NEW.cosigned_role FROM user_facility_roles r
    WHERE r.facility_id = NEW.facility_id AND r.user_id = NEW.cosigned_by AND r.role = 'facility_admin';
    IF NEW.cosigned_role IS NULL THEN
      RAISE EXCEPTION 'decision: co-signer % is not an Admin at facility %', NEW.cosigned_by, NEW.facility_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    NEW.cosigned_role := NULL;
  END IF;
  SELECT d.id INTO latest_decision FROM decisions d
  WHERE d.facility_id = NEW.facility_id AND d.referral_id = NEW.referral_id ORDER BY d.decided_at DESC LIMIT 1;
  IF NEW.amends_decision_id IS NOT NULL THEN
    IF NEW.decided_role <> 'facility_admin' THEN
      RAISE EXCEPTION 'decision: only an Admin may amend' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.amends_decision_id IS DISTINCT FROM latest_decision THEN
      RAISE EXCEPTION 'decision: an amendment must name the latest decision % of referral %', latest_decision, NEW.referral_id USING ERRCODE = 'check_violation';
    END IF;
  ELSIF latest_decision IS NOT NULL THEN
    RAISE EXCEPTION 'decision: referral % already has decision %; use an amendment', NEW.referral_id, latest_decision USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;

-- b. ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX decisions_one_amendment_per_decision ON decisions (facility_id, amends_decision_id) WHERE amends_decision_id IS NOT NULL;
CREATE UNIQUE INDEX facts_one_successor_per_fact ON facts (facility_id, supersedes) WHERE supersedes IS NOT NULL;

-- c. ---------------------------------------------------------------------------------------------
ALTER TABLE facts DROP CONSTRAINT facts_created_by_check;
ALTER TABLE facts ADD CONSTRAINT facts_created_by_check CHECK (
  created_by ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR created_by ~ '^worker:[a-z0-9-]{1,64}$');

-- d. ---------------------------------------------------------------------------------------------
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_format;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_format CHECK (
  actor ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR actor ~ '^worker:[a-z0-9-]{1,64}$' OR actor ~ '^system:[a-z0-9_]{1,63}$' OR actor ~ '^platform:[a-z0-9_]{1,63}$');
ALTER TABLE platform_audit_log DROP CONSTRAINT platform_audit_log_actor_check;
ALTER TABLE platform_audit_log ADD CONSTRAINT platform_audit_log_actor_check CHECK (
  actor ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR actor ~ '^system:[a-z0-9_]{1,63}$' OR actor ~ '^platform:[a-z0-9_]{1,63}$');

-- e. ---------------------------------------------------------------------------------------------
CREATE FUNCTION user_facility_roles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_org uuid;
  facility_org uuid;
BEGIN
  -- Both lookups bypass nothing: users is org-scoped and facilities facility-scoped, so the caller must be
  -- bound to the organisation and the facility it is granting at; an unbound caller sees neither and fails.
  SELECT organization_id INTO user_org FROM users WHERE id = NEW.user_id;
  SELECT organization_id INTO facility_org FROM facilities WHERE facility_id = NEW.facility_id;
  IF user_org IS NULL OR facility_org IS NULL OR user_org <> facility_org THEN
    RAISE EXCEPTION 'user_facility_roles: user % and facility % are not visible in the same organisation', NEW.user_id, NEW.facility_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_facility_roles_guard BEFORE INSERT OR UPDATE ON user_facility_roles FOR EACH ROW EXECUTE FUNCTION user_facility_roles_guard();
ALTER TABLE user_facility_roles ENABLE ALWAYS TRIGGER user_facility_roles_guard;

CREATE FUNCTION user_facility_roles_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r user_facility_roles%ROWTYPE := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id)
  VALUES (r.facility_id, 'platform:' || current_user,
          CASE TG_OP WHEN 'INSERT' THEN 'user_role.granted' WHEN 'DELETE' THEN 'user_role.revoked' ELSE 'user_role.changed' END,
          'user', r.user_id);
  RETURN NULL;
END
$$;
CREATE TRIGGER user_facility_roles_audit AFTER INSERT OR UPDATE OR DELETE ON user_facility_roles FOR EACH ROW EXECUTE FUNCTION user_facility_roles_audit();
ALTER TABLE user_facility_roles ENABLE ALWAYS TRIGGER user_facility_roles_audit;

-- f. ---------------------------------------------------------------------------------------------
DROP TRIGGER documents_status_guard ON documents;
CREATE OR REPLACE FUNCTION documents_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ref_status referral_status;
BEGIN
  IF NEW.status = OLD.status THEN
    IF NEW.not_applicable_reason IS DISTINCT FROM OLD.not_applicable_reason THEN
      RAISE EXCEPTION 'document % reason may only change together with its status', NEW.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO ref_status FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id;
  IF current_user = 'codex_worker' THEN
    IF OLD.status <> 'uploaded' OR NEW.status NOT IN ('processed', 'failed', 'unreadable')
       OR ref_status NOT IN ('processing', 'partial_failure') THEN
      RAISE EXCEPTION 'codex_worker may not move document % from % to % (referral %)', NEW.id, OLD.status, NEW.status, ref_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF current_user = 'codex_app' THEN
    IF NEW.status <> 'not_applicable' OR OLD.status NOT IN ('uploaded', 'failed', 'unreadable') THEN
      RAISE EXCEPTION 'codex_app may not move document % from % to %', NEW.id, OLD.status, NEW.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER documents_status_guard BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION documents_status_guard();
ALTER TABLE documents ENABLE ALWAYS TRIGGER documents_status_guard;
