CREATE TABLE "notification_read_cursors" (
	"reader" text PRIMARY KEY,
	"user_id" text,
	"activity_at" timestamp(3) with time zone NOT NULL,
	"notification_id" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_read_cursors_reader_check" CHECK (("notification_read_cursors"."reader" = 'agent' and "notification_read_cursors"."user_id" is null) or "notification_read_cursors"."reader" = 'user:' || "notification_read_cursors"."user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_revisions" (
	"notification_id" text,
	"revision" integer,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"data" jsonb,
	"card" jsonb,
	"reply" jsonb,
	"reply_round" integer NOT NULL,
	"activity_at" timestamp(3) with time zone NOT NULL,
	"replaced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_revisions_pkey" PRIMARY KEY("notification_id","revision")
);
--> statement-breakpoint
ALTER TABLE "notification_response_deliveries" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_response_deliveries" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "notification_response_deliveries" ADD COLUMN "agent_instructions" jsonb;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD COLUMN "target_type" text DEFAULT 'destination' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD COLUMN "agent_instructions" text;--> statement-breakpoint
ALTER TABLE "notification_responses" ADD COLUMN "round" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "notification_responses" ADD COLUMN "revision" integer;--> statement-breakpoint
-- Each existing answer is round 1 and created the notification's response revision.
UPDATE "notification_responses" SET "revision" = "notifications"."response_revision" FROM "notifications" WHERE "notifications"."id" = "notification_responses"."notification_id";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "card" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "activity_at" timestamp(3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Existing notifications last moved when they were pushed or last edited. Kept
-- to the millisecond, like the JavaScript Date read positions are written from.
UPDATE "notifications" SET "activity_at" = date_trunc('milliseconds', coalesce("edited_at", "created_at"));--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "reply_round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_responses" DROP CONSTRAINT "notification_responses_pkey";--> statement-breakpoint
ALTER TABLE "notification_responses" ADD PRIMARY KEY ("notification_id","round");--> statement-breakpoint
ALTER TABLE "notification_response_routes" ALTER COLUMN "target_destination_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "notification_response_deliveries_notification_destination_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_response_deliveries_notification_destination_idx" ON "notification_response_deliveries" ("notification_id","round","destination_id");--> statement-breakpoint
CREATE INDEX "notifications_activity_idx" ON "notifications" ("activity_at","id");--> statement-breakpoint
ALTER TABLE "notification_read_cursors" ADD CONSTRAINT "notification_read_cursors_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD CONSTRAINT "notification_response_routes_5CDPz6v9cxYl_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification_revisions" ADD CONSTRAINT "notification_revisions_notification_id_notifications_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agent_session_id_agent_sessions_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD CONSTRAINT "notification_response_routes_target_check" CHECK ((
        ("notification_response_routes"."target_type" = 'destination' and "notification_response_routes"."target_destination_id" is not null and "notification_response_routes"."agent_session_id" is null and "notification_response_routes"."agent_instructions" is null)
        or ("notification_response_routes"."target_type" = 'agent' and "notification_response_routes"."target_destination_id" is null)
      ));--> statement-breakpoint
-- Everyone who exists when the timeline ships has read everything so far.
INSERT INTO "notification_read_cursors" ("reader", "user_id", "activity_at")
SELECT 'user:' || "id", "id", date_trunc('milliseconds', now()) FROM "user";--> statement-breakpoint
INSERT INTO "notification_read_cursors" ("reader", "user_id", "activity_at") VALUES ('agent', NULL, date_trunc('milliseconds', now()));
