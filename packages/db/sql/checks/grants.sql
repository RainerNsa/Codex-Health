-- CONSTRAINTS check (dev-alignment 0.10; I3, I4). Must return zero rows. Each returned row names a violation.
-- Covers EVERY non-superuser role in the cluster, not two hard-coded names, except the built-in pg_* roles
-- and the RDS-managed rds_* roles. codex_app and codex_worker are still named so that making one of them
-- SUPERUSER (which would drop it out of the enumeration) is itself reported. Two further rows (SPEC §12,
-- security review #2): no role at all may hold BYPASSRLS (the owner included: FORCE RLS binds it only while
-- it lacks the attribute), and SUPERUSER is allowed only for the bootstrap/master roles named below.
WITH required(rolname) AS (VALUES ('codex_app'), ('codex_worker'), ('codex_anchor')),
superuser_allowed(rolname) AS (VALUES ('postgres'), ('codex_ci'), ('rdsadmin')),   -- the RDS master codex_admin is not rolsuper
checked AS (
  SELECT rolname
  FROM pg_roles
  WHERE NOT rolsuper
    AND rolname <> 'codex_migrator'
    AND rolname NOT LIKE 'pg\_%'
    AND rolname NOT LIKE 'rds\_%'
)
SELECT k.rolname, 'role is missing' AS problem
FROM required k
WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = k.rolname)
UNION ALL
SELECT r.rolname, 'role is SUPERUSER'
FROM pg_roles r JOIN required k USING (rolname)
WHERE r.rolsuper
UNION ALL
-- A superuser reports rolbypassrls implicitly; it is governed by the SUPERUSER row below instead.
SELECT r.rolname, 'role has BYPASSRLS'
FROM pg_roles r
WHERE r.rolbypassrls AND NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'
UNION ALL
SELECT r.rolname, 'role is SUPERUSER and not a bootstrap/master role'
FROM pg_roles r
WHERE r.rolsuper AND r.rolname NOT LIKE 'pg\_%' AND r.rolname NOT LIKE 'rds\_%'
  AND NOT EXISTS (SELECT 1 FROM superuser_allowed s WHERE s.rolname = r.rolname)
UNION ALL
SELECT k.rolname, 'role has CREATE on schema public'
FROM checked k
WHERE has_schema_privilege(k.rolname, 'public', 'CREATE')
UNION ALL
-- has_any_column_privilege also counts a table-level grant, and catches GRANT UPDATE (col) ON audit_log,
-- which has_table_privilege would miss. DELETE and TRUNCATE exist only at table level.
SELECT k.rolname, 'role has UPDATE on ' || t.tbl || ' (table- or column-level)'
FROM checked k
CROSS JOIN (VALUES ('audit_log'), ('platform_audit_log'), ('evaluations'), ('decisions'), ('facts'), ('product_events')) AS t(tbl)
WHERE to_regclass('public.' || t.tbl) IS NOT NULL
  AND has_any_column_privilege(k.rolname, 'public.' || t.tbl, 'UPDATE')
UNION ALL
SELECT k.rolname, 'role has ' || p.priv || ' on ' || t.tbl
FROM checked k
CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS p(priv)
CROSS JOIN (VALUES ('audit_log'), ('platform_audit_log'), ('evaluations'), ('decisions'), ('facts'), ('product_events')) AS t(tbl)
WHERE to_regclass('public.' || t.tbl) IS NOT NULL
  AND has_table_privilege(k.rolname, 'public.' || t.tbl, p.priv)
UNION ALL
SELECT 'audit_log', 'audit_log table is missing'
WHERE to_regclass('public.audit_log') IS NULL
UNION ALL
SELECT t.tbl, 'no enabled BEFORE INSERT row trigger computes the hash chain on ' || t.tbl
FROM (VALUES ('audit_log'), ('platform_audit_log')) AS t(tbl)
WHERE to_regclass('public.' || t.tbl) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger g
    WHERE g.tgrelid = to_regclass('public.' || t.tbl)
      AND NOT g.tgisinternal AND g.tgenabled = 'A'   -- ENABLE ALWAYS: fires under session_replication_role = replica too
      AND (g.tgtype & 1) <> 0 AND (g.tgtype & 2) <> 0 AND (g.tgtype & 4) <> 0   -- row-level, BEFORE, INSERT
      AND g.tgfoid::regproc::text LIKE '%chain%'
      AND pg_get_functiondef(g.tgfoid) LIKE '%sha256(%'   -- a renamed no-op cannot pass as the chain
  )
UNION ALL

-- The owner holds no grant to revoke, so append-only for the owner rests on the trigger. The owner can
-- disable or drop it (ALTER TABLE ... DISABLE TRIGGER); this row is what catches that.
-- tgtype bits: 1 = row-level, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE. tgenabled 'O' = enabled, 'A' = always.
SELECT t.tbl, 'no ENABLE ALWAYS statement-level trigger blocks ' || t.ops || ' on ' || t.tbl
FROM (VALUES ('audit_log', 'UPDATE, DELETE and TRUNCATE', 8 | 16 | 32),
             ('platform_audit_log', 'UPDATE, DELETE and TRUNCATE', 8 | 16 | 32),
             ('evaluations', 'UPDATE, DELETE and TRUNCATE', 8 | 16 | 32),
             ('decisions', 'UPDATE, DELETE and TRUNCATE', 8 | 16 | 32),
             ('facts', 'UPDATE', 16),
             ('product_events', 'UPDATE', 16)) AS t(tbl, ops, bits)
WHERE to_regclass('public.' || t.tbl) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger t2
    WHERE t2.tgrelid = to_regclass('public.' || t.tbl)
      AND NOT t2.tgisinternal
      AND t2.tgenabled = 'A'
      AND (t2.tgtype & 1) = 0
      AND (t2.tgtype & t.bits) = t.bits
  )
UNION ALL
-- Every guard trigger the data model relies on exists under its name and is ENABLE ALWAYS (0003/0005): a dropped,
-- renamed, disabled or replica-skipped guard is reported, not just a disabled one.
SELECT e.tbl, 'guard trigger ' || e.trg || ' is missing or not ENABLE ALWAYS'
FROM (VALUES
  ('referrals', 'referrals_worker_status_guard'), ('documents', 'documents_status_guard'),
  ('facts', 'facts_insert_guard'), ('evaluations', 'evaluations_insert_guard'),
  ('decisions', 'decisions_guard'), ('decisions', 'decisions_audit'),
  ('organizations', 'organizations_provisioning_audit'), ('facilities', 'facilities_provisioning_audit'),
  ('users', 'users_provisioning_audit'), ('product_events', 'product_events_insert_guard'),
  ('user_facility_roles', 'user_facility_roles_guard'), ('user_facility_roles', 'user_facility_roles_audit')) AS e(tbl, trg)
WHERE to_regclass('public.' || e.tbl) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger g
    WHERE g.tgrelid = to_regclass('public.' || e.tbl) AND g.tgname = e.trg AND NOT g.tgisinternal AND g.tgenabled = 'A')
UNION ALL
-- product_events: the attrs allowlist CHECK exists and the function behind it still enumerates every §14.1 event
-- and still walks the keys (a permissive replacement cannot pass as the allowlist).
SELECT 'product_events', 'attrs allowlist CHECK or its functions are missing or hollowed out'
WHERE to_regclass('public.product_events') IS NOT NULL
  AND NOT (
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.product_events') AND conname = 'product_events_attrs_allowlisted' AND contype = 'c')
    AND pg_get_functiondef('product_event_attrs_ok(text, jsonb)'::regprocedure) LIKE '%jsonb_each(%'
    AND (SELECT bool_and(pg_get_functiondef('product_event_allowed_attrs(text)'::regprocedure) LIKE '%''' || e || '''%')
         FROM unnest(ARRAY['referral.received', 'referral.uploaded', 'document.processed', 'document.failed', 'referral.ready',
                            'review.started', 'review.ended', 'evidence.viewed', 'fact.confirmed', 'fact.corrected', 'fact.entered',
                            'evaluation.created', 'decision.finalized', 'decision.amended', 'referral.held', 'referral.info_requested',
                            'referral.escalated', 'pilot.outcome_recorded', 'pilot.adjudicated']) AS e)
  )
ORDER BY 1, 2;
