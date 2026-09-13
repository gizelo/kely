ALTER TABLE brand_event DROP CONSTRAINT IF EXISTS brand_event_field_check;
ALTER TABLE brand_event ADD CONSTRAINT brand_event_field_check CHECK(field IN ('audience','palette','headlines','artDirection','voice','sourceStrategy'));
