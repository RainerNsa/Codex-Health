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
-- How the move is protected (security review of PR #24):
--   * codex_app holds no UPDATE on referrals at all; the status moves only inside referral_transitions_apply,
--     a SECURITY DEFINER function run as the owner, and only if the referral is still in from_status (a
--     multi-row INSERT cannot replay a stale from_status);
--   * codex_app inserts a referral as draft only (INSERT is granted on facility_id alone);
--   * an original decision by codex_app needs the referral in ready_for_review, and at commit the referral must
--     be finalized: a decision never exists without its T12 row (deferred constraint trigger);
--   * T12 names a decision on the referral's latest evaluation.
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
    AND (note IS NULL OR transition NOT IN ('T12', 'T14'))
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
         AND d.amends_decision_id IS NULL AND 'user:' || d.decided_by::text = NEW.created_by
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

-- SECURITY DEFINER: runs as the owner, the only role that may move a referral for the app. RLS still binds it to
-- the session's facility (FORCE). Trigger functions cannot be called directly.
CREATE FUNCTION referral_transitions_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE referrals SET status = NEW.to_status, updated_at = now()
  WHERE facility_id = NEW.facility_id AND id = NEW.referral_id AND status = NEW.from_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'referral_transitions: referral is no longer %', NEW.from_status USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id)
  VALUES (NEW.facility_id, NEW.created_by, CASE NEW.transition
      WHEN 'T8' THEN 'referral.held' WHEN 'T9' THEN 'referral.info_requested' WHEN 'T10' THEN 'referral.escalated'
      WHEN 'T11' THEN 'referral.resumed' WHEN 'T12' THEN 'referral.finalized' WHEN 'T14' THEN 'referral.submitted_for_review' END,
    'referral', NEW.referral_id);
  RETURN NULL;
END
$$;

-- Belt and braces to the missing grant: the app role never writes a referral row directly, and inserts drafts only.
CREATE FUNCTION referrals_app_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'codex_app' AND (TG_OP = 'UPDATE' OR NEW.status <> 'draft') THEN
    RAISE EXCEPTION 'referrals: codex_app moves a referral only through referral_transitions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

-- An original decision by the app is made from ready_for_review, and is finalized (T12) in the same transaction.
CREATE FUNCTION decisions_app_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'codex_app' AND NEW.amends_decision_id IS NULL
     AND (SELECT status FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id) IS DISTINCT FROM 'ready_for_review' THEN
    RAISE EXCEPTION 'decisions: an original decision needs the referral in ready_for_review' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE FUNCTION decisions_finalized_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amends_decision_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM referral_transitions t WHERE t.facility_id = NEW.facility_id AND t.decision_id = NEW.id AND t.transition = 'T12') THEN
    RAISE EXCEPTION 'decisions: decision % was never finalized (no T12 row)', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER referral_transitions_guard BEFORE INSERT ON referral_transitions FOR EACH ROW EXECUTE FUNCTION referral_transitions_guard();
CREATE TRIGGER referral_transitions_apply AFTER INSERT ON referral_transitions FOR EACH ROW EXECUTE FUNCTION referral_transitions_apply();
CREATE TRIGGER referral_transitions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON referral_transitions FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
CREATE TRIGGER referrals_app_status_guard BEFORE INSERT OR UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION referrals_app_status_guard();
CREATE TRIGGER decisions_app_guard BEFORE INSERT ON decisions FOR EACH ROW EXECUTE FUNCTION decisions_app_guard();
-- for the app role only: owner-written fixtures and the M6 import path predate T12
CREATE CONSTRAINT TRIGGER decisions_finalized_check AFTER INSERT ON decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (current_user = 'codex_app') EXECUTE FUNCTION decisions_finalized_check();
ALTER TABLE referral_transitions ENABLE ALWAYS TRIGGER referral_transitions_guard;
ALTER TABLE referral_transitions ENABLE ALWAYS TRIGGER referral_transitions_apply;
ALTER TABLE referral_transitions ENABLE ALWAYS TRIGGER referral_transitions_immutable;
ALTER TABLE referrals ENABLE ALWAYS TRIGGER referrals_app_status_guard;
ALTER TABLE decisions ENABLE ALWAYS TRIGGER decisions_app_guard;
ALTER TABLE decisions ENABLE ALWAYS TRIGGER decisions_finalized_check;
REVOKE EXECUTE ON FUNCTION referral_transitions_apply() FROM PUBLIC;

ALTER TABLE referral_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referral_transitions USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

GRANT SELECT, INSERT ON referral_transitions TO codex_app;
REVOKE UPDATE, DELETE, TRUNCATE ON referral_transitions FROM codex_app, codex_worker;
-- the app never updates a referral row; it inserts drafts (facility_id only, every other column defaulted)
REVOKE UPDATE, INSERT ON referrals FROM codex_app;
GRANT INSERT (facility_id) ON referrals TO codex_app;
-- UPDATE on one column only so the API can take the row lock (SELECT ... FOR UPDATE needs it); the guard trigger
-- refuses every UPDATE the app role actually issues.
GRANT UPDATE (updated_at) ON referrals TO codex_app;
-- shortcut: codex_app keeps PUBLIC's TEMP on the database (temp tables and triggers); with no UPDATE grant on
-- referrals it cannot move a status that way. Revoke TEMP from PUBLIC when the sandbox database is provisioned.
