CREATE TABLE "staff_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_email" text NOT NULL,
	"action" text NOT NULL,
	"org_id" uuid,
	"org_name" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "staff_actions_created_idx" ON "staff_actions" USING btree ("created_at");