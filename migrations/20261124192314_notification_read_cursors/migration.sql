CREATE TABLE "notification_read_cursors" (
	"reader" text PRIMARY KEY,
	"user_id" text,
	"activity_at" timestamp with time zone NOT NULL,
	"notification_id" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_read_cursors_reader_check" CHECK (("notification_read_cursors"."reader" = 'agent' and "notification_read_cursors"."user_id" is null) or "notification_read_cursors"."reader" = 'user:' || "notification_read_cursors"."user_id")
);
--> statement-breakpoint
ALTER TABLE "notification_read_cursors" ADD CONSTRAINT "notification_read_cursors_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Everyone who exists when the timeline ships has read everything so far.
INSERT INTO "notification_read_cursors" ("reader", "user_id", "activity_at")
SELECT 'user:' || "id", "id", now() FROM "user";--> statement-breakpoint
INSERT INTO "notification_read_cursors" ("reader", "user_id", "activity_at") VALUES ('agent', NULL, now());
