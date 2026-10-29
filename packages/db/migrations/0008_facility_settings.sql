-- 0008: M3 slice 1 — facility settings (SPEC §2 "org-level base rule set with per-facility on/off and profile
-- parameters", §8 profile v0, dev-alignment 1.7, D2, R7). Replaces the API's seed shortcut.
--   rule_sets         organisation scope, versioned, immutable. One row per version holds the whole rule set as
--                     rule.v0 records. Written only by the owner / provisioning path (the in-app rule editor was
--                     declined, X7); every version writes a platform audit row in the same statement.
--   facility_profiles facility scope, versioned, immutable. Each version holds the capability keys (profile v0)
--                     and the facility's switched-off rule ids. An Admin writes a new version through the API;
--                     every version writes a facility audit row in the same statement.
-- An evaluation already pins rule_set_version and facility_profile_version (§7), so a decision can always be
-- replayed against the exact settings it used.

-- Shape checks live in functions: a CHECK cannot hold a subquery.
CREATE FUNCTION rule_set_ids_ok(rules jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rules) r
                     WHERE jsonb_typeof(r) <> 'object' OR coalesce(r->>'id', '') !~ '^[a-z][a-z0-9_.]*$')
     AND (SELECT count(DISTINCT r->>'id') FROM jsonb_array_elements(rules) r) = jsonb_array_length(rules)
$$;
CREATE FUNCTION profile_capabilities_ok(capabilities jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_each(capabilities) c
    WHERE NOT CASE
      WHEN c.key IN ('accepts_ventilator', 'accepts_tracheostomy', 'accepts_dialysis', 'accepts_bariatric', 'accepts_iv_antibiotics', 'accepts_isolation')
        THEN jsonb_typeof(c.value) = 'boolean'
      WHEN c.key IN ('ventilator_beds', 'bariatric_beds', 'isolation_rooms', 'max_patient_weight_kg')
        THEN jsonb_typeof(c.value) = 'number' AND (c.value #>> '{}') ~ '^[0-9]{1,6}$'
      ELSE false
    END)
$$;

CREATE TABLE rule_sets (
  organization_id        uuid NOT NULL REFERENCES organizations (id),
  version                integer NOT NULL CHECK (version >= 1),
  criteria_document_ref  text NOT NULL CHECK (btrim(criteria_document_ref) <> ''),
  rules                  jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) >= 1),
  created_by             text NOT NULL CHECK (created_by ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|platform:[a-z0-9_]{1,63})$'),
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, version),
  -- every record has a snake_case id and the ids are unique within the set (the engine refuses duplicates too)
  CONSTRAINT rule_sets_rule_ids CHECK (rule_set_ids_ok(rules))
);

CREATE TABLE facility_profiles (
  facility_id     uuid NOT NULL REFERENCES facilities (facility_id),
  version         integer NOT NULL CHECK (version >= 1),
  capabilities    jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'),
  disabled_rules  text[] NOT NULL DEFAULT '{}',
  created_by      text NOT NULL CHECK (created_by ~ '^(user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|platform:[a-z0-9_]{1,63})$'),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (facility_id, version),
  -- profile v0 keys only, each of its declared type (boolean, or an integer count >= 0); anything else is refused
  CONSTRAINT facility_profiles_capabilities_v0 CHECK (profile_capabilities_ok(capabilities)),
  CONSTRAINT facility_profiles_disabled_rule_ids CHECK (array_position(disabled_rules, NULL) IS NULL)
);

-- Versions are dense from 1 and chosen by the database, never by the writer; one writer per scope at a time.
CREATE FUNCTION settings_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  IF TG_TABLE_NAME = 'rule_sets' THEN
    PERFORM pg_advisory_xact_lock(hashtext('rule_sets'), hashtext(NEW.organization_id::text));
    SELECT max(version) INTO latest FROM rule_sets WHERE organization_id = NEW.organization_id;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('facility_profiles'), hashtext(NEW.facility_id::text));
    SELECT max(version) INTO latest FROM facility_profiles WHERE facility_id = NEW.facility_id;
  END IF;
  NEW.version := coalesce(latest, 0) + 1;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION settings_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rule_sets' THEN
    INSERT INTO platform_audit_log (organization_id, actor, action, entity_type, entity_id)
    VALUES (NEW.organization_id, NEW.created_by, 'rule_set.versioned', 'rule_set', NULL);
  ELSE
    INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id)
    VALUES (NEW.facility_id, NEW.created_by, 'facility_profile.versioned', 'facility_profile', NULL);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER rule_sets_version BEFORE INSERT ON rule_sets FOR EACH ROW EXECUTE FUNCTION settings_version_guard();
CREATE TRIGGER rule_sets_audit AFTER INSERT ON rule_sets FOR EACH ROW EXECUTE FUNCTION settings_audit();
CREATE TRIGGER rule_sets_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON rule_sets FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
CREATE TRIGGER facility_profiles_version BEFORE INSERT ON facility_profiles FOR EACH ROW EXECUTE FUNCTION settings_version_guard();
CREATE TRIGGER facility_profiles_audit AFTER INSERT ON facility_profiles FOR EACH ROW EXECUTE FUNCTION settings_audit();
CREATE TRIGGER facility_profiles_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON facility_profiles FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
ALTER TABLE rule_sets ENABLE ALWAYS TRIGGER rule_sets_version;
ALTER TABLE rule_sets ENABLE ALWAYS TRIGGER rule_sets_audit;
ALTER TABLE rule_sets ENABLE ALWAYS TRIGGER rule_sets_immutable;
ALTER TABLE facility_profiles ENABLE ALWAYS TRIGGER facility_profiles_version;
ALTER TABLE facility_profiles ENABLE ALWAYS TRIGGER facility_profiles_audit;
ALTER TABLE facility_profiles ENABLE ALWAYS TRIGGER facility_profiles_immutable;

ALTER TABLE rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rule_sets USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE facility_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON facility_profiles USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

-- The app reads both and appends profile versions (Admin-only, enforced in the API); it never writes rule sets.
GRANT SELECT ON rule_sets TO codex_app;
GRANT SELECT, INSERT ON facility_profiles TO codex_app;
REVOKE UPDATE, DELETE, TRUNCATE ON rule_sets, facility_profiles FROM codex_app, codex_worker;
