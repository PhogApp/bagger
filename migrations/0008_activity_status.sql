ALTER TABLE "activities" ALTER COLUMN "occurred_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "due_on" date;--> statement-breakpoint
CREATE INDEX "activities_open_idx" ON "activities" USING btree ("org_id","owner_id","status","due_on");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_status_dates" CHECK (("activities"."status" = 'open' and "activities"."due_on" is not null and "activities"."occurred_at" is null) or ("activities"."status" = 'completed' and "activities"."occurred_at" is not null));