-- 0013: M3 slice 6 — the referral queue reads one facility's referrals in one status set, ordered by
-- (updated_at, id), one page at a time. This index serves that read and its keyset cursor directly, so a page
-- costs the same however many referrals a facility has (security review of PR #28).
CREATE INDEX referrals_queue ON referrals (facility_id, status, updated_at, id);
