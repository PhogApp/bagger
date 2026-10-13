-- Email messages become HTML so they can carry bold, links and lists.
-- Existing plain-text email bodies are converted: special characters are
-- escaped, blank lines start new paragraphs and single line breaks stay.
-- LinkedIn messages stay plain text. Bodies that already hold tags are left alone.
CREATE FUNCTION pg_temp.bagger_text_to_html(body text) RETURNS text AS $$
  SELECT '<p>' || regexp_replace(
    regexp_replace(
      btrim(
        replace(replace(replace(replace(body, E'\r\n', E'\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
        E' \n\t'
      ),
      E'\n[ \t]*\n[\n \t]*', '</p><p>', 'g'
    ),
    E'\n', '<br>', 'g'
  ) || '</p>'
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
UPDATE "templates"
SET "body" = pg_temp.bagger_text_to_html("body")
WHERE "type" = 'email'
  AND btrim("body") <> ''
  AND "body" !~* '</?(p|br|strong|b|em|i|u|a|ul|ol|li)([ >/])';
--> statement-breakpoint
UPDATE "sequence_steps"
SET "body" = pg_temp.bagger_text_to_html("body")
WHERE "type" = 'email'
  AND "body" IS NOT NULL
  AND btrim("body") <> ''
  AND "body" !~* '</?(p|br|strong|b|em|i|u|a|ul|ol|li)([ >/])';
--> statement-breakpoint
UPDATE "step_tasks" t
SET "override_body" = pg_temp.bagger_text_to_html(t."override_body")
FROM "sequence_steps" s
WHERE s."id" = t."step_id"
  AND s."type" = 'email'
  AND t."override_body" IS NOT NULL
  AND btrim(t."override_body") <> ''
  AND t."override_body" !~* '</?(p|br|strong|b|em|i|u|a|ul|ol|li)([ >/])';
