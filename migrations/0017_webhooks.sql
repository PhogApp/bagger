CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"secret" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"position" jsonb NOT NULL,
	"failing_since" timestamp with time zone,
	"created_by" uuid,
	"api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_feed" ADD COLUMN "fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("org_id");--> statement-breakpoint
-- The change feed also keeps which fields changed in each transaction.
CREATE OR REPLACE FUNCTION "bagger_change_feed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "change_feed" ("org_id", "tx_id", "record_type", "record_id", "action", "source", "connection_id", "fields")
  VALUES (NEW."org_id", pg_current_xact_id()::text::bigint, NEW."record_type", NEW."record_id",
          NEW."action"::text, NEW."source"::text, NEW."connection_id",
          CASE WHEN NEW."field" IS NULL THEN '{}'::text[] ELSE ARRAY[NEW."field"] END)
  ON CONFLICT ("tx_id", "record_type", "record_id") DO UPDATE SET
    "action" = CASE
      WHEN "change_feed"."action" = 'create' AND EXCLUDED."action" <> 'delete' THEN 'create'
      WHEN EXCLUDED."action" = 'delete' THEN 'delete'
      ELSE "change_feed"."action" END,
    "fields" = CASE
      WHEN EXCLUDED."fields" = '{}' OR EXCLUDED."fields"[1] = ANY ("change_feed"."fields") THEN "change_feed"."fields"
      ELSE "change_feed"."fields" || EXCLUDED."fields" END;
  RETURN NULL;
END $$;
