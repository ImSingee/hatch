ALTER TABLE "agent_models" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_models" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- The single instance-wide image model setting is retired; image models are
-- now added as models of kind "image".
DELETE FROM "platform_config" WHERE "key" = 'image.model';
