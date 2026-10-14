CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"amount_cents" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"stripe_invoice_id" text,
	"hosted_url" text,
	"pdf_url" text,
	"failure_message" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "seat_started_on" date DEFAULT current_date NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "card_brand" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "card_last4" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "card_expires" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "cancels_on" date;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_period_uq" ON "invoices" USING btree ("org_id","period");--> statement-breakpoint
CREATE INDEX "invoices_stripe_idx" ON "invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
-- Existing seats started when the person joined.
UPDATE "memberships" SET "seat_started_on" = ("created_at" AT TIME ZONE 'America/Chicago')::date;
