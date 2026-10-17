ALTER TYPE "public"."enrollment_end_reason" ADD VALUE 'converted';--> statement-breakpoint
CREATE INDEX "enrollments_lead_idx" ON "enrollments" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "enrollments_contact_idx" ON "enrollments" USING btree ("contact_id");--> statement-breakpoint
-- A lead's sequence history stays with the lead. Conversions before this
-- moved it to the contact; put the finished runs from before conversion back.
-- Runs still going carry on with the contact, as they were.
UPDATE "enrollments" e
SET "lead_id" = l."id", "contact_id" = NULL
FROM "leads" l
WHERE l."converted_contact_id" = e."contact_id"
  AND l."org_id" = e."org_id"
  AND e."state" = 'ended'
  AND e."enrolled_at" < l."converted_at";
