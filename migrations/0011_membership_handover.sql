ALTER TABLE "memberships" ADD COLUMN "hand_to_user_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "removed_by" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_hand_to_user_id_users_id_fk" FOREIGN KEY ("hand_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_ending_idx" ON "memberships" USING btree ("org_id","status","ends_on");