CREATE TABLE "status_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"object" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"effect" text DEFAULT 'none' NOT NULL,
	"color" text DEFAULT 'neutral' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "status_options" ADD CONSTRAINT "status_options_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_options_org_object_name_uq" ON "status_options" USING btree ("org_id","object",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "status_options_one_default_uq" ON "status_options" USING btree ("org_id","object") WHERE "status_options"."is_default";--> statement-breakpoint
DROP TYPE "public"."account_status";--> statement-breakpoint
DROP TYPE "public"."person_status";--> statement-breakpoint
-- Give every existing organization the statuses it had when they were fixed
-- lists, plus starting stages for opportunities. New organizations get the
-- same set from server/statuses/defaults.ts; keep the two in step.
INSERT INTO "status_options" ("org_id", "object", "name", "position", "is_default", "effect", "color")
SELECT o."id", v."object", v."name", v."position", v."is_default", v."effect", v."color"
FROM "organizations" o
CROSS JOIN (VALUES
	('leads', 'New', 1, true, 'none', 'ocean'),
	('leads', 'Active', 2, false, 'none', 'teal'),
	('leads', 'Prospecting', 3, false, 'none', 'sage'),
	('leads', 'Not Interested', 4, false, 'ends_sequence', 'neutral'),
	('leads', 'Do Not Contact', 5, false, 'do_not_contact', 'rose'),
	('contacts', 'New', 1, true, 'none', 'ocean'),
	('contacts', 'Active', 2, false, 'none', 'teal'),
	('contacts', 'Prospecting', 3, false, 'none', 'sage'),
	('contacts', 'Not Interested', 4, false, 'ends_sequence', 'neutral'),
	('contacts', 'Do Not Contact', 5, false, 'do_not_contact', 'rose'),
	('accounts', 'Active', 1, true, 'none', 'teal'),
	('accounts', 'Customer', 2, false, 'none', 'teal'),
	('accounts', 'Vendor', 3, false, 'none', 'neutral'),
	('accounts', 'Partner', 4, false, 'none', 'sage'),
	('accounts', 'Inactive', 5, false, 'none', 'neutral'),
	('accounts', 'Do Not Contact', 6, false, 'none', 'rose'),
	('opportunities', 'Prospecting', 1, true, 'none', 'ocean'),
	('opportunities', 'Qualified', 2, false, 'none', 'sage'),
	('opportunities', 'Proposal', 3, false, 'none', 'teal'),
	('opportunities', 'Negotiation', 4, false, 'none', 'mauve'),
	('opportunities', 'Closed Won', 5, false, 'won', 'teal'),
	('opportunities', 'Closed Lost', 6, false, 'lost', 'neutral')
) AS v("object", "name", "position", "is_default", "effect", "color");
