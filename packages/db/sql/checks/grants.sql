-- CONSTRAINTS check (dev-alignment 0.10; I3, I4). Must return zero rows. Each returned row names a violation.
-- Covers EVERY non-superuser role in the cluster, not two hard-coded names, except the built-in pg_* roles
-- and the RDS-managed rds_* roles. codex_app and codex_worker are still named so that making one of them
-- SUPERUSER (which would drop it out of the enumeration) is itself reported. Two further rows (SPEC §12,
-- security review #2): no role at all may hold BYPASSRLS (the owner included: FORCE RLS binds it only while
-- it lacks the attribute), and SUPERUSER is allowed only for the bootstrap/master roles named below.
WITH required(rolname) AS (VALUES ('codex_app'), ('codex_worker')),
superuser_allowed(rolname) AS (VALUES ('postgres'), ('codex_ci'), ('codex_admin'), ('rdsadmin')),
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
SELECT k.rolname, 'role has UPDATE on audit_log (table- or column-level)'
FROM checked k
WHERE to_regclass('public.audit_log') IS NOT NULL
  AND has_any_column_privilege(k.rolname, 'public.audit_log', 'UPDATE')
UNION ALL
SELECT k.rolname, 'role has ' || p.priv || ' on audit_log'
FROM checked k
CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS p(priv)
WHERE to_regclass('public.audit_log') IS NOT NULL
  AND has_table_privilege(k.rolname, 'public.audit_log', p.priv)
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
      AND NOT g.tgisinternal AND g.tgenabled IN ('O', 'A')
      AND (g.tgtype & 1) <> 0 AND (g.tgtype & 2) <> 0 AND (g.tgtype & 4) <> 0   -- row-level, BEFORE, INSERT
      AND g.tgfoid::regproc::text LIKE '%chain%'
      AND pg_get_functiondef(g.tgfoid) LIKE '%sha256(%'   -- a renamed no-op cannot pass as the chain
  )
UNION ALL
SELECT k.rolname, 'role has UPDATE on platform_audit_log (table- or column-level)'
FROM checked k
WHERE to_regclass('public.platform_audit_log') IS NOT NULL
  AND has_any_column_privilege(k.rolname, 'public.platform_audit_log', 'UPDATE')
UNION ALL
SELECT k.rolname, 'role has ' || p.priv || ' on platform_audit_log'
FROM checked k
CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS p(priv)
WHERE to_regclass('public.platform_audit_log') IS NOT NULL
  AND has_table_privilege(k.rolname, 'public.platform_audit_log', p.priv)
UNION ALL
-- The owner holds no grant to revoke, so append-only for the owner rests on the trigger. The owner can
-- disable or drop it (ALTER TABLE ... DISABLE TRIGGER); this row is what catches that.
-- tgtype bits: 1 = row-level, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE. tgenabled 'O' = enabled, 'A' = always.
SELECT t.tbl, 'no enabled statement-level trigger blocks UPDATE, DELETE and TRUNCATE on ' || t.tbl
FROM (VALUES ('audit_log'), ('platform_audit_log')) AS t(tbl)
WHERE to_regclass('public.' || t.tbl) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger t2
    WHERE t2.tgrelid = to_regclass('public.' || t.tbl)
      AND NOT t2.tgisinternal
      AND t2.tgenabled IN ('O', 'A')
      AND (t2.tgtype & 1) = 0
      AND (t2.tgtype & 8) <> 0
      AND (t2.tgtype & 16) <> 0
      AND (t2.tgtype & 32) <> 0
  )
ORDER BY 1, 2;
