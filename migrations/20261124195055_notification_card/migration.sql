ALTER TABLE "notification_revisions" ADD COLUMN "card" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "card" jsonb;