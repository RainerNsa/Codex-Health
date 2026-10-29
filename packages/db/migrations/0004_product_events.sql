-- 0004: M1 slice 3 — product_events (SPEC §14.1; dev-alignment 0.5, 3.3). One append-only, tenant-scoped
-- table that feeds the usability sessions (§13 rows 7 and 11), the CONSTRAINTS §6 measurements and every
-- §17 pilot metric. Rows carry ids, timestamps, durations and codes, never a fact value, a quote or a name:
-- the attrs allowlist below is enforced per event by CHECK, key by key, type by type, and for every coded
-- key against its vocabulary, so no free text fits. Not hash-chained. PHI-bearing all the same (a timestamp
-- per referral is a date of service): short purge class, deleted with the referral (ON DELETE CASCADE);
-- exported only as aggregates (6.7).
--
-- Also tightens the audit actors from 0001/0002: a user is a uuid, a worker is a job id, system and platform
-- actors are short lowercase names. Nothing else fits in an actor.

ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_format;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_format CHECK (
  actor ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR actor ~ '^worker:[a-z0-9-]{1,64}$' OR actor ~ '^system:[a-z_]{1,32}$' OR actor ~ '^platform:[a-z_]{1,32}$');
ALTER TABLE platform_audit_log DROP CONSTRAINT platform_audit_log_actor_check;
ALTER TABLE platform_audit_log ADD CONSTRAINT platform_audit_log_actor_check CHECK (
  actor ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR actor ~ '^system:[a-z_]{1,32}$' OR actor ~ '^platform:[a-z_]{1,32}$');

CREATE TABLE product_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id  uuid NOT NULL,
  referral_id  uuid NOT NULL,
  actor        text NOT NULL CHECK (
                 actor ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 OR actor ~ '^worker:[a-z0-9-]{1,64}$'),
  event        text NOT NULL,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),   -- overwritten by the trigger: never writer-chosen
  attrs        jsonb NOT NULL DEFAULT '{}',
  UNIQUE (facility_id, id),
  FOREIGN KEY (facility_id, referral_id) REFERENCES referrals (facility_id, id) ON DELETE CASCADE
);
CREATE INDEX product_events_referral_idx ON product_events (facility_id, referral_id, at);

-- The §14.1 allowlist: event → permitted attrs keys, each with its type. A row with an unknown event, an
-- unknown key, or a value of the wrong shape or outside its vocabulary is refused.
--   uuid; int (0..10^15); bool; ts (ISO timestamp, validated as a real date by the trigger);
--   fact_key (snake_case, <= 40 chars; the fact_definitions list binds it at M2);
--   outcome | sub_reasons | screen | stage | department | cause | verdict: closed vocabularies.
CREATE FUNCTION product_event_allowed_attrs(p_event text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_event
    WHEN 'referral.received'       THEN '{"received_at":"ts"}'
    WHEN 'referral.uploaded'       THEN '{"document_id":"uuid","pages":"int","bytes":"int"}'
    WHEN 'document.processed'      THEN '{"document_id":"uuid","pages_ocr":"int","duration_ms":"int"}'
    WHEN 'document.failed'         THEN '{"document_id":"uuid","pages_ocr":"int","stage":"stage","duration_ms":"int"}'
    WHEN 'referral.ready'          THEN '{"evaluation_id":"uuid","outcome":"outcome","sub_reasons":"sub_reasons","blocking_count":"int"}'
    WHEN 'review.started'          THEN '{"screen":"screen"}'
    WHEN 'review.ended'            THEN '{"screen":"screen","active_ms":"int"}'
    WHEN 'evidence.viewed'         THEN '{"fact_key":"fact_key","document_id":"uuid","page":"int","decisive":"bool"}'
    WHEN 'fact.confirmed'          THEN '{"fact_key":"fact_key","decisive":"bool"}'
    WHEN 'fact.corrected'          THEN '{"fact_key":"fact_key","decisive":"bool"}'
    WHEN 'fact.entered'            THEN '{"fact_key":"fact_key","decisive":"bool"}'
    WHEN 'evaluation.created'      THEN '{"evaluation_id":"uuid","previous_evaluation_id":"uuid","raw":"bool","outcome":"outcome","changed_fact_count":"int"}'
    WHEN 'decision.finalized'      THEN '{"decision_id":"uuid","evaluation_id":"uuid","outcome":"outcome","override":"bool","cosigner_present":"bool","decisive_fact_count":"int","decisive_viewed_count":"int"}'
    WHEN 'decision.amended'        THEN '{"decision_id":"uuid","evaluation_id":"uuid","outcome":"outcome","override":"bool","cosigner_present":"bool","decisive_fact_count":"int","decisive_viewed_count":"int"}'
    WHEN 'referral.held'           THEN '{}'
    WHEN 'referral.info_requested' THEN '{"items_requested":"int"}'
    WHEN 'referral.escalated'      THEN '{"department":"department"}'
    WHEN 'pilot.outcome_recorded'  THEN '{"decision_id":"uuid","cause":"cause"}'
    WHEN 'pilot.adjudicated'       THEN '{"decision_id":"uuid","cause":"cause","verdict":"verdict"}'
    ELSE NULL
  END::jsonb
$$;

CREATE FUNCTION product_event_vocabulary(p_type text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    WHEN 'outcome'     THEN ARRAY['admit', 'needs_review', 'do_not_admit']
    WHEN 'sub_reasons' THEN ARRAY['missing_info', 'clinical', 'financial', 'leadership', 'processing_incomplete']
    WHEN 'screen'      THEN ARRAY['login', 'facility_select', 'queue', 'new_referral', 'upload', 'processing', 'review', 'recommendation', 'decision', 'history', 'settings']
    WHEN 'stage'       THEN ARRAY['upload', 'classify', 'ocr', 'extract', 'verify', 'evaluate']
    WHEN 'department'  THEN ARRAY['administrator', 'director_of_nursing', 'medical_director', 'business_office', 'therapy', 'social_services']
    WHEN 'cause'       THEN ARRAY['incorrect_extraction', 'missing_information', 'incorrect_rule_logic', 'facility_specific_exception', 'human_judgment', 'error_in_existing_process', 'outside_tool_scope']
    WHEN 'verdict'     THEN ARRAY['tool_correct', 'process_correct', 'both_wrong', 'indeterminate']
    ELSE NULL
  END
$$;

CREATE FUNCTION product_event_attrs_ok(p_event text, p_attrs jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p_attrs) = 'object'
    AND product_event_allowed_attrs(p_event) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_attrs) AS a(key, value)
      LEFT JOIN jsonb_each_text(product_event_allowed_attrs(p_event)) AS t(key, type) USING (key)
      WHERE t.type IS NULL                                                            -- key not allowed for this event
         OR NOT CASE t.type
              WHEN 'uuid'     THEN jsonb_typeof(a.value) = 'string' AND (a.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              WHEN 'int'      THEN jsonb_typeof(a.value) = 'number' AND (a.value #>> '{}') ~ '^[0-9]{1,15}$'
              WHEN 'bool'     THEN jsonb_typeof(a.value) = 'boolean'
              WHEN 'ts'       THEN jsonb_typeof(a.value) = 'string' AND (a.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
              WHEN 'fact_key' THEN jsonb_typeof(a.value) = 'string' AND (a.value #>> '{}') ~ '^[a-z][a-z0-9_]{0,39}$'
              WHEN 'sub_reasons' THEN jsonb_typeof(a.value) = 'array' AND jsonb_array_length(a.value) <= 5
                                      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a.value) e
                                                      WHERE jsonb_typeof(e) <> 'string' OR NOT ((e #>> '{}') = ANY (product_event_vocabulary('sub_reasons'))))
              ELSE jsonb_typeof(a.value) = 'string' AND (a.value #>> '{}') = ANY (coalesce(product_event_vocabulary(t.type), ARRAY[]::text[]))
            END
    )
$$;

ALTER TABLE product_events ADD CONSTRAINT product_events_attrs_allowlisted CHECK (product_event_attrs_ok(event, attrs));

-- What a CHECK cannot do: pin the timestamp, validate a date for real, and keep a specially protected fact
-- key out (§14.1: fact_key is omitted for a specially_protected key; facts.specially_protected is known here).
CREATE FUNCTION product_events_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  received timestamptz;
BEGIN
  NEW.at := clock_timestamp();
  IF NEW.attrs ? 'received_at' THEN
    received := (NEW.attrs->>'received_at')::timestamptz;   -- raises on an impossible date
    IF received < '2000-01-01' OR received > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'product_events: received_at % is outside the plausible range', NEW.attrs->>'received_at' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.attrs ? 'fact_key' AND EXISTS (
       SELECT 1 FROM facts f
       WHERE f.facility_id = NEW.facility_id AND f.referral_id = NEW.referral_id
         AND f.key = NEW.attrs->>'fact_key' AND f.specially_protected) THEN
    RAISE EXCEPTION 'product_events: fact_key must be omitted for a specially protected fact' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER product_events_insert_guard BEFORE INSERT ON product_events FOR EACH ROW EXECUTE FUNCTION product_events_insert_guard();
ALTER TABLE product_events ENABLE ALWAYS TRIGGER product_events_insert_guard;

-- Append-only for everyone; DELETE only by the owner (purge) or by the referral's own deletion.
CREATE TRIGGER product_events_immutable BEFORE UPDATE ON product_events FOR EACH STATEMENT EXECUTE FUNCTION rows_are_immutable();
ALTER TABLE product_events ENABLE ALWAYS TRIGGER product_events_immutable;

ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_events USING (facility_id = NULLIF(current_setting('app.facility_id', true), '')::uuid);

-- The app reads and emits; the worker only emits (the API computes every derived metric).
GRANT SELECT, INSERT ON product_events TO codex_app;
GRANT INSERT ON product_events TO codex_worker;
GRANT SELECT ON facts TO codex_app;   -- already held; the guard reads facts under the caller's RLS
REVOKE UPDATE, DELETE, TRUNCATE ON product_events FROM codex_app, codex_worker;
