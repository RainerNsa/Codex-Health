-- CONSTRAINTS check (dev-alignment 0.10 / 1.9; I3). Must return zero rows. Each returned row names a violation.
-- 1. Every relation (table, partitioned table, materialized view) with a facility_id column has row-level
--    security ENABLED and FORCED and at least one policy. A materialized view can never satisfy this, which is
--    the point: it would copy tenant rows out from under the policies.
-- 2. Every policy on such a relation scopes on app.facility_id. A policy with a count of one that reads
--    anything else (USING (true), a role name, a different setting) is a cross-tenant hole that rule 1 misses.
-- 3. Every table in public carries facility_id unless it is on the allowlist of non-tenant tables below.
--    Growing that list is a reviewed change to this check, not to the migration.
WITH rels AS (
  SELECT c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity,
         EXISTS (
           SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'facility_id' AND NOT a.attisdropped
         ) AS has_facility_id
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'm')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_%'
)
SELECT nspname AS table_schema, relname AS table_name, 'RLS not enabled' AS problem
FROM rels
WHERE has_facility_id AND NOT relrowsecurity
UNION ALL
SELECT nspname, relname, 'RLS not forced'
FROM rels
WHERE has_facility_id AND NOT relforcerowsecurity
UNION ALL
SELECT nspname, relname, 'no policy'
FROM rels r
WHERE has_facility_id AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = r.oid)
UNION ALL
-- USING and WITH CHECK are concatenated so an INSERT-only policy (USING is NULL) is judged on its WITH CHECK,
-- and a NULL never turns the comparison into "not a violation".
SELECT r.nspname, r.relname, 'policy ' || p.polname || ' does not reference app.facility_id'
FROM rels r
JOIN pg_policy p ON p.polrelid = r.oid
WHERE r.has_facility_id
  AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
      NOT LIKE '%app.facility_id%'
UNION ALL
SELECT nspname, relname, 'table in public without facility_id (not on the non-tenant allowlist)'
FROM rels
WHERE nspname = 'public'
  AND NOT has_facility_id
  AND relname NOT IN ('organizations', 'users', 'schema_migrations')
ORDER BY 1, 2, 3;
