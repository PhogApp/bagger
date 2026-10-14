ALTER TABLE "organizations" ADD COLUMN "trial_ends_on" date;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "first_billed_on" date;--> statement-breakpoint
-- Organizations already billed have had their first bill; those with a card but
-- no bill yet get their free week from today.
UPDATE "organizations" o SET "first_billed_on" = b.first, "trial_ends_on" = b.first
FROM (SELECT "org_id", min(("created_at" AT TIME ZONE 'America/Chicago')::date) AS first FROM "invoices" GROUP BY "org_id") b
WHERE b."org_id" = o."id";--> statement-breakpoint
UPDATE "organizations" SET "trial_ends_on" = (now() AT TIME ZONE 'America/Chicago')::date + 7
WHERE "card_last4" IS NOT NULL AND "trial_ends_on" IS NULL;
