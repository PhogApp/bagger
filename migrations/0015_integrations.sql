ALTER TYPE "public"."history_source" ADD VALUE 'integration';--> statement-breakpoint
CREATE TABLE "change_feed" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"tx_id" bigint NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"connection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"external_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"account_label" text,
	"external_account_id" text,
	"credentials" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_by" uuid,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dedupe_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"counts" jsonb,
	"errors" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "field_history" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "field_history" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "change_feed" ADD CONSTRAINT "change_feed_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_feed_tx_record_uq" ON "change_feed" USING btree ("tx_id","record_type","record_id");--> statement-breakpoint
CREATE INDEX "change_feed_org_tx_idx" ON "change_feed" USING btree ("org_id","tx_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_external_uq" ON "external_links" USING btree ("connection_id","record_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_record_uq" ON "external_links" USING btree ("connection_id","record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_org_provider_uq" ON "integration_connections" USING btree ("org_id","provider");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "sync_runs_connection_idx" ON "sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
ALTER TABLE "field_history" ADD CONSTRAINT "field_history_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The change feed: one row per record per transaction, from whatever wrote history.
CREATE FUNCTION "bagger_change_feed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "change_feed" ("org_id", "tx_id", "record_type", "record_id", "action", "source", "connection_id")
  VALUES (NEW."org_id", pg_current_xact_id()::text::bigint, NEW."record_type", NEW."record_id",
          NEW."action"::text, NEW."source"::text, NEW."connection_id")
  ON CONFLICT ("tx_id", "record_type", "record_id") DO UPDATE SET "action" = CASE
    WHEN "change_feed"."action" = 'create' AND EXCLUDED."action" <> 'delete' THEN 'create'
    WHEN EXCLUDED."action" = 'delete' THEN 'delete'
    ELSE "change_feed"."action" END;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "field_history_change_feed" AFTER INSERT ON "field_history"
  FOR EACH ROW EXECUTE FUNCTION "bagger_change_feed"();--> statement-breakpoint
-- Admins manage integrations.
UPDATE "roles" SET "permissions" = "permissions" || '{"setup.integrations": true}'::jsonb
WHERE "preset_key" = 'admin';
