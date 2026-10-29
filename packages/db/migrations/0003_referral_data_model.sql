-- 0003: M1 slice 2 — the referral data model (SPEC §4, §5, §7, §8, §9, §14.2; dev-alignment 1.2, 1.4, 1.5,
-- 1.6, 6.2; CONSTRAINTS I3, I4, I5, I6). Four tenant tables, each FORCE RLS on app.facility_id and joined to
-- its parent by a composite key so a row can never reference another facility's (or another referral's) row.
--
-- Retention classes (§9): documents and facts are PHI on the short purge class (the deletion job, M6, deletes
-- as the owner). evaluations and decisions are the 6-year class: ids, keys, codes, versions and the override
-- reason (free text, PHI-free by instruction; counsel confirms under F10), never a quote or a packet value.
-- Both are immutable for everyone, the owner included.
--
-- Not enforced here, by design (API guards at M3): a user correction that flips a hard-stop input requires
-- the co-sign (open question 24) — the database does not know the hard-stop key set until rules exist.

ALTER TABLE referrals ADD CONSTRAINT referrals_facility_id_id_key UNIQUE (facility_id, id);

-- Guard and immutability triggers from 0001/0002 fire even under session_replication_role = replica.
ALTER TABLE audit_log          ENABLE ALWAYS TRIGGER audit_log_immutable;
ALTER TABLE audit_log          ENABLE ALWAYS TRIGGER audit_log_chain;
ALTER TABLE platform_audit_log ENABLE ALWAYS TRIGGER platform_audit_log_immutable;
ALTER TABLE platform_audit_log ENABLE ALWAYS TRIGGER platform_audit_log_chain;
ALTER TABLE organizations      ENABLE ALWAYS TRIGGER organizations_provisioning_audit;
ALTER TABLE facilities         ENABLE ALWAYS TRIGGER facilities_provisioning_audit;
ALTER TABLE users              ENABLE ALWAYS TRIGGER users_provisioning_audit;
ALTER TABLE referrals          ENABLE ALWAYS TRIGGER referrals_worker_status_guard;

CREATE FUNCTION rows_are_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

-- documents ----------------------------------------------------------------------------------------
CREATE TYPE document_status AS ENUM ('uploaded', 'processed', 'failed', 'unreadable', 'not_applicable');

CREATE TABLE documents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id            uuid NOT NULL,
  referral_id            uuid NOT NULL,
  type                   text NOT NULL CHECK (type ~ '^[a-z][a-z_]*$'),   -- classification code, never a title
  status                 document_status NOT NULL DEFAULT 'uploaded',
  not_applicable_reason  text,
  sha256                 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  pages                  integer CHECK (pages IS NULL OR pages >= 0),
  storage_key            text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, id),
  UNIQUE (referral_id, sha256),                                           -- §8 duplicate check, per referral
  FOREIGN KEY (facility_id, referral_id) REFERENCES referrals (facility_id, id),
  -- the S3 key is derived from the row, so it can only ever point into this facility's and referral's prefix
  CHECK (storage_key = 'documents/' || facility_id::text || '/' || referral_id::text || '/' || encode(sha256, 'hex')),
  -- 1.4: not_applicable needs a reason; nothing else may carry one
  CHECK ((status = 'not_applicable') = (not_applicable_reason IS NOT NULL AND btrim(not_applicable_reason) <> ''))
);

-- SPEC §5 T2–T5 and §12 worker row: the worker reports processing results on an in-flight referral only; the
-- app's only status write is not_applicable (T5). Nobody rewrites a terminal status.
CREATE FUNCTION documents_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ref_status referral_status;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
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
CREATE TRIGGER documents_status_guard BEFORE UPDATE OF status ON documents FOR EACH ROW EXECUTE FUNCTION documents_status_guard();
ALTER TABLE documents ENABLE ALWAYS TRIGGER documents_status_guard;

-- facts ---------------------------------------------------------------------------------------------
-- One row per assertion; a correction or re-extraction is a new row that supersedes the old one, so the
-- pre-correction value is always retained (1.2, §3). value and evidence follow packages/schemas fact.v0.
CREATE TYPE fact_source AS ENUM ('ai', 'user');
CREATE TYPE confidence_band AS ENUM ('high', 'medium', 'low');

CREATE TABLE facts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id          uuid NOT NULL,
  referral_id          uuid NOT NULL,
  key                  text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  value                jsonb NOT NULL,
  source               fact_source NOT NULL,
  evidence             jsonb,
  note                 text,
  as_of_date           date,
  is_critical          boolean NOT NULL DEFAULT false,
  specially_protected  boolean NOT NULL DEFAULT false,
  single_source        boolean NOT NULL DEFAULT false,
  confidence_band      confidence_band,
  supersedes           uuid,
  created_by           text NOT NULL CHECK (created_by ~ '^(user|worker):[A-Za-z0-9._-]+$'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, id),
  UNIQUE (facility_id, referral_id, id),
  FOREIGN KEY (facility_id, referral_id) REFERENCES referrals (facility_id, id),
  -- a correction supersedes a fact of the same facility AND referral (key equality is checked by the trigger)
  FOREIGN KEY (facility_id, referral_id, supersedes) REFERENCES facts (facility_id, referral_id, id),
  CHECK (supersedes IS NULL OR supersedes <> id),
  -- value: a tagged union with a known type; a tri_state value is exactly yes/no/unknown; a count is >= 0
  CONSTRAINT facts_value_shape CHECK (
    jsonb_typeof(value) = 'object' AND value ? 'type' AND value ? 'value'
    AND value->>'type' IN ('tri_state', 'count', 'date', 'enum', 'text', 'medication_list')
    AND (value->>'type' <> 'tri_state' OR coalesce(value->>'value', '') IN ('yes', 'no', 'unknown'))   -- coalesce: a JSON null must violate, not evaluate to NULL
    AND (value->>'type' <> 'count' OR jsonb_typeof(value->'value') = 'null' OR (jsonb_typeof(value->'value') = 'number' AND (value->>'value')::numeric >= 0))
  ),
  -- a user fact carries a note and no evidence or band; an ai fact carries no note (fact.v0 allOf[0])
  CONSTRAINT facts_user_shape CHECK (source <> 'user' OR (note IS NOT NULL AND btrim(note) <> '' AND evidence IS NULL AND confidence_band IS NULL)),
  CONSTRAINT facts_ai_no_note CHECK (source <> 'ai' OR note IS NULL),
  -- a known ai value carries evidence; an unknown one carries none (fact.v0 allOf[1])
  CONSTRAINT facts_ai_evidence_iff_known CHECK (
    source <> 'ai'
    OR (evidence IS NOT NULL) = (
      CASE WHEN value->>'type' = 'tri_state' THEN value->>'value' <> 'unknown'
           ELSE jsonb_typeof(value->'value') <> 'null' END
    )
  ),
  CONSTRAINT facts_evidence_shape CHECK (
    evidence IS NULL
    OR (jsonb_typeof(evidence) = 'object'
        AND btrim(coalesce(evidence->>'document_id', '')) <> ''
        AND jsonb_typeof(evidence->'page') = 'number' AND (evidence->>'page')::numeric >= 1
        AND btrim(coalesce(evidence->>'quote', '')) <> ''
        AND jsonb_typeof(evidence->'verified') = 'boolean')
  )
);

CREATE INDEX facts_referral_key_idx ON facts (facility_id, referral_id, key);

-- Who may assert what (§12 worker row; 14.2 raw vs verified): the worker writes only ai facts as itself,
-- the app writes only user facts as a user. A new assertion for a key that already has one must supersede
-- the latest, and may only supersede a row with the same key.
CREATE FUNCTION facts_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest uuid;
  superseded_key text;
BEGIN
  IF current_user = 'codex_worker' AND (NEW.source <> 'ai' OR NEW.created_by NOT LIKE 'worker:%') THEN
    RAISE EXCEPTION 'codex_worker may only insert ai facts as worker:<job>' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user = 'codex_app' AND (NEW.source <> 'user' OR NEW.created_by NOT LIKE 'user:%') THEN
    RAISE EXCEPTION 'codex_app may only insert user facts as user:<id>' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT f.id INTO latest FROM facts f
  WHERE f.facility_id = NEW.facility_id AND f.referral_id = NEW.referral_id AND f.key = NEW.key
    AND NOT EXISTS (SELECT 1 FROM facts n WHERE n.facility_id = f.facility_id AND n.supersedes = f.id)
  ORDER BY f.created_at DESC LIMIT 1;
  IF latest IS NOT NULL AND NEW.supersedes IS DISTINCT FROM latest THEN
    RAISE EXCEPTION 'fact % for key % must supersede the latest assertion %', NEW.id, NEW.key, latest USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes IS NOT NULL THEN
    SELECT key INTO superseded_key FROM facts WHERE facility_id = NEW.facility_id AND id = NEW.supersedes;
    IF superseded_key IS DISTINCT FROM NEW.key THEN
      RAISE EXCEPTION 'fact % may not supersede a fact of another key', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER facts_insert_guard BEFORE INSERT ON facts FOR EACH ROW EXECUTE FUNCTION facts_insert_guard();
ALTER TABLE facts ENABLE ALWAYS TRIGGER facts_insert_guard;

-- Facts are never rewritten: a correction is a new row. DELETE stays possible for the owner only (purge).
CREATE TRIGGER facts_immutable BEFORE UPDATE ON facts FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
ALTER TABLE facts ENABLE ALWAYS TRIGGER facts_immutable;

-- evaluations ---------------------------------------------------------------------------------------
-- One immutable snapshot per engine run (I6, §14.2). raw = the AI-only snapshot before any human touched a
-- fact; only the worker may write one. trace holds rule ids, fact keys, sub-reason codes, missing and
-- conflicting keys and the ranked blocking list: ids, keys and codes only; a quote or note key anywhere in it
-- is refused.
CREATE TYPE outcome AS ENUM ('admit', 'needs_review', 'do_not_admit');
CREATE TYPE financial_status AS ENUM ('clear', 'hold', 'unknown');   -- engineering default pending F8

CREATE TABLE evaluations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id               uuid NOT NULL,
  referral_id               uuid NOT NULL,
  previous_evaluation_id    uuid,
  raw                       boolean NOT NULL,
  outcome                   outcome NOT NULL,
  clinical_outcome          outcome NOT NULL,
  financial_status          financial_status NOT NULL,
  sub_reasons               text[] NOT NULL DEFAULT '{}',
  trace                     jsonb NOT NULL,
  -- §7: every version pinned, exact strings, never aliases
  criteria_document_ref     text NOT NULL CHECK (btrim(criteria_document_ref) <> ''),
  rule_set_version          integer NOT NULL CHECK (rule_set_version >= 1),
  facility_profile_version  integer NOT NULL CHECK (facility_profile_version >= 1),
  model_id                  text NOT NULL CHECK (model_id ~ '^anthropic\.claude-[a-z0-9-]+-[0-9]{8}-v[0-9]+:[0-9]+$' OR model_id = 'none'),
  prompt_version            text NOT NULL CHECK (btrim(prompt_version) <> ''),
  extractor_version         text NOT NULL CHECK (btrim(extractor_version) <> ''),
  ocr_engine_version        text NOT NULL CHECK (btrim(ocr_engine_version) <> ''),
  engine_version            text NOT NULL CHECK (btrim(engine_version) <> ''),
  evaluated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (facility_id, id),
  UNIQUE (facility_id, referral_id, id),
  FOREIGN KEY (facility_id, referral_id) REFERENCES referrals (facility_id, id),
  FOREIGN KEY (facility_id, referral_id, previous_evaluation_id) REFERENCES evaluations (facility_id, referral_id, id),
  CHECK (previous_evaluation_id IS NULL OR previous_evaluation_id <> id),
  CONSTRAINT evaluations_trace_shape CHECK (
    jsonb_typeof(trace) = 'object'
    AND NOT jsonb_path_exists(trace, 'strict $.**.quote') AND NOT jsonb_path_exists(trace, 'strict $.**.note')
  ),
  CONSTRAINT evaluations_sub_reasons_codes CHECK (sub_reasons <@ ARRAY['missing_info', 'clinical', 'financial', 'leadership', 'processing_incomplete']::text[]),
  CONSTRAINT evaluations_needs_review_iff_reasons CHECK ((outcome = 'needs_review') = (cardinality(sub_reasons) > 0)),
  -- §4 step 2 precedes everything but step 1: a clinical hard stop is the outcome
  CONSTRAINT evaluations_hard_stop_is_outcome CHECK (clinical_outcome <> 'do_not_admit' OR outcome = 'do_not_admit')
);

CREATE FUNCTION evaluations_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'codex_app' AND NEW.raw THEN
    RAISE EXCEPTION 'codex_app may not write a raw evaluation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER evaluations_insert_guard BEFORE INSERT ON evaluations FOR EACH ROW EXECUTE FUNCTION evaluations_insert_guard();
ALTER TABLE evaluations ENABLE ALWAYS TRIGGER evaluations_insert_guard;
CREATE TRIGGER evaluations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
ALTER TABLE evaluations ENABLE ALWAYS TRIGGER evaluations_immutable;

-- decisions -----------------------------------------------------------------------------------------
-- A decision pins exactly one evaluation, the referral's latest (I6, T12). An override needs a non-blank
-- reason; a hard stop → Admit override (on the merged or the clinical outcome) needs a co-signing Admin who is
-- a different user, enforced here, not in the UI (I5, 6.2). One original decision per referral; every later
-- one is an amendment by an Admin that names the latest decision; no row is ever updated (decision 11, T13).
CREATE TABLE decisions (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id                    uuid NOT NULL,
  referral_id                    uuid NOT NULL,
  evaluation_id                  uuid NOT NULL,
  recommended_outcome            outcome NOT NULL,   -- copied from the evaluation; the trigger verifies it
  recommended_clinical_outcome   outcome NOT NULL,   -- set by the trigger from the evaluation
  decision                       outcome NOT NULL CHECK (decision <> 'needs_review'),
  override_reason                text,
  hard_stop_override             boolean NOT NULL GENERATED ALWAYS AS (
                                   (recommended_outcome = 'do_not_admit' OR recommended_clinical_outcome = 'do_not_admit') AND decision = 'admit') STORED,
  decided_by                     uuid NOT NULL REFERENCES users (id),
  decided_role                   facility_role NOT NULL,   -- snapshot, set by the trigger from user_facility_roles
  cosigned_by                    uuid REFERENCES users (id),
  cosigned_role                  facility_role,            -- snapshot, set by the trigger; must be facility_admin
  amends_decision_id             uuid,
  amendment_reason               text,
  decided_at                     timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (facility_id, id),
  UNIQUE (facility_id, referral_id, id),
  FOREIGN KEY (facility_id, referral_id) REFERENCES referrals (facility_id, id),
  FOREIGN KEY (facility_id, referral_id, evaluation_id) REFERENCES evaluations (facility_id, referral_id, id),
  FOREIGN KEY (facility_id, referral_id, amends_decision_id) REFERENCES decisions (facility_id, referral_id, id),
  CHECK (amends_decision_id IS NULL OR amends_decision_id <> id),
  -- I5: override reason, rejected when empty or whitespace; none when there is no override
  CONSTRAINT decisions_override_reason_iff_override CHECK ((decision <> recommended_outcome) = (override_reason IS NOT NULL AND btrim(override_reason) <> '')),
  -- I5: second approver, different user, Admin role; nobody co-signs their own decision, hard stop or not
  CONSTRAINT decisions_hard_stop_cosign CHECK (NOT hard_stop_override OR (cosigned_by IS NOT NULL AND cosigned_role = 'facility_admin')),
  CONSTRAINT decisions_cosigner_is_other_user CHECK (cosigned_by IS NULL OR cosigned_by <> decided_by),
  -- unreachable through INSERT (the trigger normalises cosigned_role); kept as a schema invariant
  CONSTRAINT decisions_cosign_pair CHECK ((cosigned_by IS NULL) = (cosigned_role IS NULL)),
  CONSTRAINT decisions_amendment_pair CHECK ((amends_decision_id IS NULL) = (amendment_reason IS NULL)),
  CONSTRAINT decisions_amendment_reason_nonblank CHECK (amendment_reason IS NULL OR btrim(amendment_reason) <> '')
);
-- one original decision per referral (T12 once; T13 thereafter)
CREATE UNIQUE INDEX decisions_one_original ON decisions (facility_id, referral_id) WHERE amends_decision_id IS NULL;

CREATE FUNCTION decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ev evaluations%ROWTYPE;
  latest_decision uuid;
BEGIN
  SELECT * INTO ev FROM evaluations e WHERE e.facility_id = NEW.facility_id AND e.id = NEW.evaluation_id;
  IF ev.id IS NULL THEN
    RAISE EXCEPTION 'decision: evaluation % is not visible for facility %', NEW.evaluation_id, NEW.facility_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF ev.outcome <> NEW.recommended_outcome OR ev.referral_id <> NEW.referral_id THEN
    RAISE EXCEPTION 'decision: recommended_outcome or referral does not match evaluation %', NEW.evaluation_id USING ERRCODE = 'check_violation';
  END IF;
  NEW.recommended_clinical_outcome := ev.clinical_outcome;
  -- T12: the pinned evaluation is the referral's latest; a stale raw snapshot cannot be decided on
  IF EXISTS (SELECT 1 FROM evaluations n WHERE n.facility_id = NEW.facility_id AND n.referral_id = NEW.referral_id AND n.evaluated_at > ev.evaluated_at) THEN
    RAISE EXCEPTION 'decision: evaluation % is not the latest for referral %', NEW.evaluation_id, NEW.referral_id USING ERRCODE = 'check_violation';
  END IF;
  -- roles are snapshots taken here, from the membership table, never supplied by the writer
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
  -- T13: only an Admin amends, and only the referral's latest decision
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
CREATE TRIGGER decisions_guard BEFORE INSERT ON decisions FOR EACH ROW EXECUTE FUNCTION decisions_guard();
ALTER TABLE decisions ENABLE ALWAYS TRIGGER decisions_guard;

-- I4: a decision that cannot be audited does not happen. Ids only; the audit row's entity is the decision,
-- whose row carries the reason and the approver snapshot (SPEC §13 row 10).
CREATE FUNCTION decisions_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id)
  VALUES (NEW.facility_id, 'user:' || NEW.decided_by::text,
          CASE WHEN NEW.amends_decision_id IS NULL THEN 'decision.finalized' ELSE 'decision.amended' END,
          'decision', NEW.id);
  IF NEW.cosigned_by IS NOT NULL THEN
    INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id)
    VALUES (NEW.facility_id, 'user:' || NEW.cosigned_by::text, 'decision.cosigned', 'decision', NEW.id);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER decisions_audit AFTER INSERT ON decisions FOR EACH ROW EXECUTE FUNCTION decisions_audit();
ALTER TABLE decisions ENABLE ALWAYS TRIGGER decisions_audit;
CREATE TRIGGER decisions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON decisions
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
ALTER TABLE decisions ENABLE ALWAYS TRIGGER decisions_immutable;

-- RLS ------------------------------------------------------------------------------------------------
ALTER TABLE documents   ENABLE ROW LEVEL SECURITY; ALTER TABLE documents   FORCE ROW LEVEL SECURITY;
ALTER TABLE facts       ENABLE ROW LEVEL SECURITY; ALTER TABLE facts       FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY; ALTER TABLE evaluations FORCE ROW LEVEL SECURITY;
ALTER TABLE decisions   ENABLE ROW LEVEL SECURITY; ALTER TABLE decisions   FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents   USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON facts       USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON evaluations USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON decisions   USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

-- Grants: the app reads and appends; the worker appends ai facts and evaluations and reports document
-- processing. Nobody but the owner may UPDATE or DELETE facts (purge), and nobody at all may on evaluations
-- or decisions.
GRANT SELECT, INSERT ON documents, facts, evaluations, decisions TO codex_app;
GRANT UPDATE (status, not_applicable_reason, updated_at) ON documents TO codex_app;
GRANT SELECT, INSERT ON facts, evaluations TO codex_worker;
GRANT SELECT ON documents TO codex_worker;
GRANT UPDATE (status, pages, updated_at) ON documents TO codex_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON facts, evaluations, decisions FROM codex_app, codex_worker;
