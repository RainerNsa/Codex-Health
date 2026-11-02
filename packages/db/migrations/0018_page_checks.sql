-- 0018: M5 step 2 (I2) — a page that rendered blank cannot be checked against, and a page view rests on a link to that page.
-- blank_pages: pages whose image came out as one flat colour (a corrupt scan). Only the worker reports it. A fact citing one has
-- no image to show, so a person states it. evidence.page_issued: ids and a page number. evidence.viewed gains fact_id: a look counts for one reading, not for every reading on the page.
ALTER TABLE documents ADD COLUMN blank_pages integer[];
GRANT UPDATE (blank_pages) ON documents TO codex_worker;

CREATE OR REPLACE FUNCTION documents_page_images_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.page_images IS NOT NULL OR NEW.blank_pages IS NOT NULL THEN
    RAISE EXCEPTION 'documents: page images are reported by the pipeline, not at insert' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION product_event_allowed_attrs(p_event text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_event
    WHEN 'referral.received'       THEN '{"received_at":"ts"}'
    WHEN 'referral.uploaded'       THEN '{"document_id":"uuid","pages":"int","bytes":"int"}'
    WHEN 'document.processed'      THEN '{"document_id":"uuid","pages_ocr":"int","duration_ms":"int"}'
    WHEN 'document.failed'         THEN '{"document_id":"uuid","pages_ocr":"int","stage":"stage","duration_ms":"int"}'
    WHEN 'referral.ready'          THEN '{"evaluation_id":"uuid","outcome":"outcome","sub_reasons":"sub_reasons","blocking_count":"int"}'
    WHEN 'review.started'          THEN '{"screen":"screen"}'
    WHEN 'review.ended'            THEN '{"screen":"screen","active_ms":"int"}'
    WHEN 'evidence.page_issued'    THEN '{"document_id":"uuid","page":"int"}'
    WHEN 'evidence.viewed'         THEN '{"fact_id":"uuid","fact_key":"fact_key","document_id":"uuid","page":"int","decisive":"bool"}'
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
