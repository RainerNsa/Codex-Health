-- 0014: M4 slice 1 — the worker evaluates a referral itself after extraction (SPEC §14.2 raw evaluation), so it
-- reads the rule set and facility profile, under the same row-level security as the API, and writes neither.
GRANT SELECT ON rule_sets, facility_profiles TO codex_worker;
