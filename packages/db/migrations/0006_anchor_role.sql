-- 0006: M1 slice 4 — the anchoring role (SPEC §12 "the chain before anchoring"; dev-alignment 1.10; decision
-- log 2026-10-29 "design decisions carried into slice 4"). Under FORCE RLS no role can list facilities, so
-- the anchoring and verification job gets its own role, codex_anchor, with exactly two named SELECT-only
-- policies: it may enumerate facility ids and organisation ids, nothing else. Every other read it makes
-- (audit_log, platform_audit_log) is bound per facility or organisation like everyone's. It writes nothing.
-- rls-enumeration.sql allows precisely these two policies by name and role.

GRANT USAGE ON SCHEMA public TO codex_anchor;
GRANT SELECT (facility_id, organization_id) ON facilities TO codex_anchor;
GRANT SELECT (id) ON organizations TO codex_anchor;
GRANT SELECT ON audit_log, platform_audit_log TO codex_anchor;

CREATE POLICY anchor_enumeration ON facilities FOR SELECT TO codex_anchor USING (true);
CREATE POLICY anchor_enumeration ON organizations FOR SELECT TO codex_anchor USING (true);
