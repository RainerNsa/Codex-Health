-- 0015: M4 slice 4 (4.1) — a document that failed on a passing fault can be tried again. The file is unchanged, so a
-- re-upload would be refused as a duplicate; the row goes back to uploaded instead, as part of T4. Only `failed`:
-- `unreadable` means it was read and nothing was legible, and trying again would give the same answer.
CREATE OR REPLACE FUNCTION documents_status_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ref_status referral_status;
BEGIN
  IF NEW.status = OLD.status THEN
    IF NEW.not_applicable_reason IS DISTINCT FROM OLD.not_applicable_reason THEN
      RAISE EXCEPTION 'document % reason may only change together with its status', NEW.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO ref_status FROM referrals WHERE facility_id = NEW.facility_id AND id = NEW.referral_id;
  IF current_user = 'codex_worker' THEN
    IF OLD.status <> 'uploaded' OR NEW.status NOT IN ('processed', 'failed', 'unreadable')
       OR ref_status NOT IN ('processing', 'partial_failure') THEN
      RAISE EXCEPTION 'codex_worker may not move document % from % to % (referral %)', NEW.id, OLD.status, NEW.status, ref_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF current_user = 'codex_app' THEN
    IF NOT ((NEW.status = 'not_applicable' AND OLD.status IN ('uploaded', 'failed', 'unreadable'))
            OR (NEW.status = 'uploaded' AND OLD.status = 'failed' AND ref_status = 'partial_failure')) THEN
      RAISE EXCEPTION 'codex_app may not move document % from % to %', NEW.id, OLD.status, NEW.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
