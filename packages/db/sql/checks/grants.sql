-- CONSTRAINTS check (dev-alignment 0.10; I3, I4). Must return zero rows. Each returned row names a violation.
-- Covers EVERY non-superuser role in the cluster, not two hard-coded names, except the schema owner
-- codex_migrator, the built-in pg_* roles and the RDS-managed rds_* roles. A superuser is excluded only
-- because its privileges are implicit; codex_app and codex_worker are still named so that making one
-- of them SUPERUSER (which would drop it out of the enumeration) is itself reported.
WITH required(rolname) AS (VALUES ('codex_app'), ('codex_worker')),
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
SELECT r.rolname, 'role has BYPASSRLS'
FROM pg_roles r JOIN checked k USING (rolname)
WHERE r.rolbypassrls
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
-- The owner holds no grant to revoke, so append-only for the owner rests on the trigger. The owner can
-- disable or drop it (ALTER TABLE ... DISABLE TRIGGER); this row is what catches that.
-- tgtype bits: 1 = row-level, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE. tgenabled 'O' = enabled, 'A' = always.
SELECT 'audit_log', 'no enabled statement-level trigger blocks UPDATE, DELETE and TRUNCATE on audit_log'
WHERE to_regclass('public.audit_log') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = to_regclass('public.audit_log')
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND (t.tgtype & 1) = 0
      AND (t.tgtype & 8) <> 0
      AND (t.tgtype & 16) <> 0
      AND (t.tgtype & 32) <> 0
  )
ORDER BY 1, 2;
