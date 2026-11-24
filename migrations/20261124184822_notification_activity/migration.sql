ALTER TABLE "notifications" ADD COLUMN "activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Existing notifications last moved when they were pushed or last edited.
UPDATE "notifications" SET "activity_at" = coalesce("edited_at", "created_at");--> statement-breakpoint
CREATE INDEX "notifications_activity_idx" ON "notifications" ("activity_at","id");
