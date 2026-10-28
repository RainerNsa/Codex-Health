-- 0002: M1 slice 1 (SPEC §12 XF-9/XF-10, security review #6/#7, dev-alignment 1.9/1.10/1.13).
--   a. audit_log: seq, prev_hash and row_hash are computed by a BEFORE INSERT trigger, never by the writer;
--      CHECKs on actor/action/entity_type; a verifier function the anchoring job and the tamper test share.
--   b. platform_audit_log: the organisation-scope chain for provisioning (organisations have no facility).
--   c. users and organizations get FORCE RLS on app.organization_id.
--   d. codex_worker may move a referral only to the states the actor matrix allows (SPEC §5.2).
-- No PHI columns. Hashes use the built-in sha256(bytea); no extension.

-- a. ---------------------------------------------------------------------------------------------
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_format CHECK (actor ~ '^(user|worker|system|platform):[A-Za-z0-9._-]+$'),
  ADD CONSTRAINT audit_log_action_format CHECK (action ~ '^[a-z][a-z0-9_.]*$'),
  ADD CONSTRAINT audit_log_entity_type_format CHECK (entity_type ~ '^[a-z][a-z_]*$');

-- One canonical byte string per row; the trigger and the verifier both hash exactly this, so they cannot drift.
CREATE FUNCTION audit_row_canon(
  p_scope text, p_scope_id uuid, p_seq bigint, p_actor text, p_action text, p_entity_type text, p_entity_id uuid, p_at timestamptz
) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT convert_to(
    p_scope || '|' || p_scope_id::text || '|' || p_seq::text || '|' || p_actor || '|' || p_action || '|' || p_entity_type
      || '|' || coalesce(p_entity_id::text, '') || '|' || to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'UTF8')
$$;

CREATE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash bytea;
BEGIN
  -- Serialise writers of one facility's chain; different facilities never wait on each other (1.10).
  PERFORM pg_advisory_xact_lock(hashtext('audit_log'), hashtext(NEW.facility_id::text));
  SELECT seq, row_hash INTO last_seq, last_hash
  FROM audit_log WHERE facility_id = NEW.facility_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.at := now();  -- never writer-chosen: the chain proves order and time of append
  NEW.row_hash := sha256(coalesce(last_hash, '\x'::bytea)
    || audit_row_canon('facility', NEW.facility_id, NEW.seq, NEW.actor, NEW.action, NEW.entity_type, NEW.entity_id, NEW.at));
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Recomputes every hash of one facility's chain under the caller's RLS binding. A row whose stored hash
-- differs from the recomputed one, or whose prev_hash is not the previous row_hash, reports ok = false.
-- Raises when no row is visible, so "nothing to check" can never read as "all good" (a caller bound to the
-- wrong facility, or a wholly deleted chain). Tail truncation and a consistent rewrite of the last row are
-- undetectable from inside the database by design; the M1 anchoring job (last row_hash and seq per facility
-- per day to the Object Lock bucket) is the control for those.
CREATE FUNCTION audit_chain_verify(p_facility_id uuid)
RETURNS TABLE (seq bigint, ok boolean) LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.facility_id = p_facility_id) THEN
    RAISE EXCEPTION 'audit_chain_verify: no audit rows visible for facility %; bind app.facility_id first', p_facility_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT a.seq,
         a.row_hash = sha256(coalesce(prev.row_hash, '\x'::bytea)
           || audit_row_canon('facility', a.facility_id, a.seq, a.actor, a.action, a.entity_type, a.entity_id, a.at))
         AND a.prev_hash IS NOT DISTINCT FROM prev.row_hash
         AND coalesce(prev.seq, 0) = a.seq - 1 AS ok
  FROM audit_log a
  LEFT JOIN audit_log prev ON prev.facility_id = a.facility_id AND prev.seq = a.seq - 1
  WHERE a.facility_id = p_facility_id
  ORDER BY a.seq;
END
$$;

-- b. ---------------------------------------------------------------------------------------------
CREATE TABLE platform_audit_log (
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  seq              bigint NOT NULL CHECK (seq > 0),
  prev_hash        bytea,
  row_hash         bytea NOT NULL,
  actor            text NOT NULL CHECK (actor ~ '^(user|system|platform):[A-Za-z0-9._-]+$'),
  action           text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]*$'),
  entity_type      text NOT NULL CHECK (entity_type ~ '^[a-z][a-z_]*$'),
  entity_id        uuid,
  at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, seq),
  CHECK ((seq = 1) = (prev_hash IS NULL))
);

CREATE FUNCTION platform_audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('platform_audit_log'), hashtext(NEW.organization_id::text));
  SELECT seq, row_hash INTO last_seq, last_hash
  FROM platform_audit_log WHERE organization_id = NEW.organization_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.at := now();
  NEW.row_hash := sha256(coalesce(last_hash, '\x'::bytea)
    || audit_row_canon('organization', NEW.organization_id, NEW.seq, NEW.actor, NEW.action, NEW.entity_type, NEW.entity_id, NEW.at));
  RETURN NEW;
END
$$;

CREATE TRIGGER platform_audit_log_chain BEFORE INSERT ON platform_audit_log FOR EACH ROW EXECUTE FUNCTION platform_audit_log_chain();
CREATE TRIGGER platform_audit_log_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

CREATE FUNCTION platform_audit_chain_verify(p_organization_id uuid)
RETURNS TABLE (seq bigint, ok boolean) LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_audit_log a WHERE a.organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'platform_audit_chain_verify: no audit rows visible for organisation %; bind app.organization_id first', p_organization_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT a.seq,
         a.row_hash = sha256(coalesce(prev.row_hash, '\x'::bytea)
           || audit_row_canon('organization', a.organization_id, a.seq, a.actor, a.action, a.entity_type, a.entity_id, a.at))
         AND a.prev_hash IS NOT DISTINCT FROM prev.row_hash
         AND coalesce(prev.seq, 0) = a.seq - 1 AS ok
  FROM platform_audit_log a
  LEFT JOIN platform_audit_log prev ON prev.organization_id = a.organization_id AND prev.seq = a.seq - 1
  WHERE a.organization_id = p_organization_id
  ORDER BY a.seq;
END
$$;

-- c. ---------------------------------------------------------------------------------------------
-- Organisation scope is bound the same way as facility scope: SET LOCAL app.organization_id per transaction.
-- Nobody but the owner (and, from M1 slice 3, the internal admin role) may insert an organisation, facility
-- or user; no grant exists yet for either beyond SELECT (migration 0001). Every such insert must be made
-- while bound to that organisation and writes one platform_audit_log row in the same statement, so a
-- provisioning write that cannot be audited does not happen (SPEC §12 XF-10, dev-alignment 1.13).
CREATE FUNCTION provisioning_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound  uuid := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  org    uuid;
  entity text;
  eid    uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'organizations' THEN org := NEW.id;              entity := 'organization'; eid := NEW.id;
    WHEN 'facilities'    THEN org := NEW.organization_id; entity := 'facility';     eid := NEW.facility_id;
    WHEN 'users'         THEN org := NEW.organization_id; entity := 'user';         eid := NEW.id;
  END CASE;
  IF bound IS NULL OR org <> bound THEN
    RAISE EXCEPTION 'provisioning: % insert for organisation % while bound to %', TG_TABLE_NAME, org, bound
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO platform_audit_log (organization_id, actor, action, entity_type, entity_id)
  VALUES (org, 'platform:' || current_user, entity || '.created', entity, eid);
  RETURN NULL;
END
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organizations
  USING (id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON users
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON platform_audit_log
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

CREATE TRIGGER organizations_provisioning_audit AFTER INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION provisioning_audit();
CREATE TRIGGER facilities_provisioning_audit    AFTER INSERT ON facilities    FOR EACH ROW EXECUTE FUNCTION provisioning_audit();
CREATE TRIGGER users_provisioning_audit         AFTER INSERT ON users         FOR EACH ROW EXECUTE FUNCTION provisioning_audit();

-- d. ---------------------------------------------------------------------------------------------
-- SPEC §5.2: the worker triggers only T2 (ready_for_review) and T3 (partial_failure), and only from a
-- referral that is in flight (processing, or partial_failure on a retry). It can never pull a finalized,
-- escalated or held referral back. Its grant is already limited to status and updated_at (0001).
CREATE FUNCTION referrals_worker_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'codex_worker'
     AND (OLD.status NOT IN ('processing', 'partial_failure')
          OR NEW.status NOT IN ('processing', 'partial_failure', 'ready_for_review')) THEN
    RAISE EXCEPTION 'codex_worker may not move a referral from % to %', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER referrals_worker_status_guard BEFORE UPDATE OF status ON referrals
  FOR EACH ROW EXECUTE FUNCTION referrals_worker_status_guard();
