CREATE TABLE "notification_revisions" (
	"notification_id" text,
	"revision" integer,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"data" jsonb,
	"reply" jsonb,
	"reply_round" integer NOT NULL,
	"activity_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_revisions_pkey" PRIMARY KEY("notification_id","revision")
);
--> statement-breakpoint
ALTER TABLE "notification_response_deliveries" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_responses" ADD COLUMN "round" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "notification_responses" ADD COLUMN "revision" integer;--> statement-breakpoint
-- Each existing answer is round 1 and created the notification's response revision.
UPDATE "notification_responses" SET "revision" = "notifications"."response_revision" FROM "notifications" WHERE "notifications"."id" = "notification_responses"."notification_id";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "reply_round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_responses" DROP CONSTRAINT "notification_responses_pkey";--> statement-breakpoint
ALTER TABLE "notification_responses" ADD PRIMARY KEY ("notification_id","round");--> statement-breakpoint
DROP INDEX "notification_response_deliveries_notification_destination_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_response_deliveries_notification_destination_idx" ON "notification_response_deliveries" ("notification_id","round","destination_id");--> statement-breakpoint
ALTER TABLE "notification_revisions" ADD CONSTRAINT "notification_revisions_notification_id_notifications_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE;