-- 0001_init: M1 skeleton, the minimum that makes the CONSTRAINTS checks checkable
-- (research/dev-alignment.md rows 1.1, 1.7, 1.9, 1.10; security.md "CONSTRAINTS.md, enforced automatically").
-- No PHI columns exist in this migration. Documents, facts and decisions arrive in later migrations, each with facility_id.
-- Tenant key: facility_id. Every table carrying it has FORCE ROW LEVEL SECURITY and a policy on app.facility_id,
-- which the API and the worker set per transaction with  SELECT set_config('app.facility_id', '<uuid>', true).

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO codex_app, codex_worker;

-- Contract entity (1.7). Not tenant-scoped: holds names only.
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facilities (
  facility_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  name             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Staff accounts (Cognito is the identity provider; this row carries the stable id and a display name, never patient data).
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  email            text NOT NULL UNIQUE,
  display_name     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE facility_role AS ENUM ('facility_admin', 'admissions_reviewer', 'viewer');

CREATE TABLE user_facility_roles (
  user_id      uuid NOT NULL REFERENCES users (id),
  facility_id  uuid NOT NULL REFERENCES facilities (facility_id),
  role         facility_role NOT NULL,
  PRIMARY KEY (user_id, facility_id, role)
);

-- Referral state machine (1.1). Transitions are enforced by the application at M1, not here.
CREATE TYPE referral_status AS ENUM (
  'draft', 'processing', 'partial_failure', 'ready_for_review', 'finalized',
  'on_hold', 'info_requested', 'escalated', 'amended'
);

CREATE TABLE referrals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id  uuid NOT NULL REFERENCES facilities (facility_id),
  status       referral_status NOT NULL DEFAULT 'draft',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Append-only, per-facility hash chain (1.10). Ids and hashes only; 6-year retention class (1.8).
-- row_hash and prev_hash are computed by the writer at M1; the chain verifier and S3 anchoring are M1 jobs.
CREATE TABLE audit_log (
  facility_id  uuid NOT NULL REFERENCES facilities (facility_id),
  seq          bigint NOT NULL CHECK (seq > 0),
  prev_hash    bytea,                           -- NULL only on the first row of a facility's chain
  row_hash     bytea NOT NULL,
  actor        text NOT NULL,                   -- user id, or a system identity such as 'worker:<job id>'; never a name
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, seq),
  CHECK ((seq = 1) = (prev_hash IS NULL))
);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Statement-level so it fires even when RLS hides every row, and for the table owner too.
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Row-level security. NULLIF guards the '' a RESET leaves behind after a session-level SET; unset means no rows.
ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON facilities
  USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

ALTER TABLE user_facility_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_facility_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_facility_roles
  USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referrals
  USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

-- Grants: only what each role needs. codex_migrator owns everything and runs only migrations and the synthetic seed.
GRANT SELECT ON organizations, facilities, users, user_facility_roles TO codex_app;
GRANT SELECT, INSERT, UPDATE ON referrals TO codex_app;
GRANT SELECT, INSERT ON audit_log TO codex_app;

GRANT SELECT ON facilities TO codex_worker;
GRANT SELECT, UPDATE (status, updated_at) ON referrals TO codex_worker;
GRANT SELECT, INSERT ON audit_log TO codex_worker;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM codex_app, codex_worker;
