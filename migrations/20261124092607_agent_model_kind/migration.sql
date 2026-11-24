ALTER TABLE "agent_models" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_models" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- The instance-wide image model selection becomes an image model of its
-- provider. A selection whose provider is gone had no effect and is dropped.
INSERT INTO "agent_models" ("id", "provider_id", "model_id", "name", "kind", "sort_order")
SELECT
  md5('image.model:' || "p"."id" || ':' || ("c"."value" ->> 'modelId')),
  "p"."id",
  "c"."value" ->> 'modelId',
  "c"."value" ->> 'modelId',
  'image',
  COALESCE(
    (SELECT max("m"."sort_order") + 1 FROM "agent_models" "m" WHERE "m"."provider_id" = "p"."id"),
    0
  )
FROM "platform_config" "c"
JOIN "agent_providers" "p" ON "p"."id" = "c"."value" ->> 'providerId'
WHERE "c"."key" = 'image.model'
  AND jsonb_typeof("c"."value") = 'object'
  AND COALESCE("c"."value" ->> 'modelId', '') <> '';--> statement-breakpoint
DELETE FROM "platform_config" WHERE "key" = 'image.model';
