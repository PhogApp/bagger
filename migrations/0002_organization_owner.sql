ALTER TABLE "organizations" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_email" text;--> statement-breakpoint
-- Organizations created before ownership existed: the first Admin to have
-- joined becomes the owner.
UPDATE "organizations" o
SET "owner_user_id" = (
  SELECT m."user_id"
  FROM "memberships" m
  JOIN "roles" r ON r."id" = m."role_id"
  WHERE m."org_id" = o."id"
    AND r."preset_key" = 'admin'
    AND m."status" IN ('active', 'ending')
  ORDER BY m."created_at", m."id"
  LIMIT 1
)
WHERE o."owner_user_id" IS NULL;
