-- 0016: M5 step 1 (I2, XF-7b) — how many page images the worker stored for a document, for a person to check facts against.
-- NULL or 0: none, so no fact on this document can be confirmed against an image. Only the worker reports it.
ALTER TABLE documents ADD COLUMN page_images integer CHECK (page_images IS NULL OR page_images >= 0);
GRANT UPDATE (page_images) ON documents TO codex_worker;

CREATE OR REPLACE FUNCTION documents_page_images_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.page_images IS NOT NULL THEN
    RAISE EXCEPTION 'documents: page images are reported by the pipeline, not at insert' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER documents_page_images_guard BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION documents_page_images_guard();
ALTER TABLE documents ENABLE ALWAYS TRIGGER documents_page_images_guard;
