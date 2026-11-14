ALTER TABLE "notification_deliveries" ADD COLUMN "delivered_revision" integer;--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD COLUMN "lifecycle_events" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "recalled_at" timestamp with time zone;--> statement-breakpoint
UPDATE "notification_deliveries" SET "delivered_revision" = 1 WHERE "status" = 'succeeded';
