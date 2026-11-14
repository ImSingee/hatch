CREATE TABLE "notification_response_deliveries" (
	"id" text PRIMARY KEY,
	"notification_id" text NOT NULL,
	"destination_id" text,
	"destination_type" text NOT NULL,
	"destination_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"http_status" integer,
	"result" text,
	"route_ids" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_response_routes" (
	"id" text PRIMARY KEY,
	"name" text,
	"source_type" text NOT NULL,
	"app_id" text,
	"channel_id" text,
	"kind" text,
	"target_destination_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_response_routes_source_check" CHECK ((
        ("notification_response_routes"."source_type" = 'app' and "notification_response_routes"."channel_id" is null)
        or ("notification_response_routes"."source_type" = 'channel' and "notification_response_routes"."app_id" is null)
        or ("notification_response_routes"."source_type" = 'any' and "notification_response_routes"."app_id" is null and "notification_response_routes"."channel_id" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "notification_responses" (
	"notification_id" text PRIMARY KEY,
	"answers" jsonb NOT NULL,
	"responded_by_user_id" text,
	"responded_by_name" text NOT NULL,
	"via" text NOT NULL,
	"destination_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD COLUMN "accepts_responses" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "reply" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "response_revision" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_response_deliveries_notification_destination_idx" ON "notification_response_deliveries" ("notification_id","destination_id");--> statement-breakpoint
CREATE INDEX "notification_response_deliveries_due_idx" ON "notification_response_deliveries" ("status","next_attempt_at") WHERE "notification_response_deliveries"."status" in ('pending', 'in_progress');--> statement-breakpoint
ALTER TABLE "notification_response_deliveries" ADD CONSTRAINT "notification_response_deliveries_664FQtBlUS29_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_response_deliveries" ADD CONSTRAINT "notification_response_deliveries_xEXDORj3XpCd_fkey" FOREIGN KEY ("destination_id") REFERENCES "notification_destinations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD CONSTRAINT "notification_response_routes_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD CONSTRAINT "notification_response_routes_7XpAeIDOrdHv_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD CONSTRAINT "notification_response_routes_kRFJ1vGo8s8J_fkey" FOREIGN KEY ("target_destination_id") REFERENCES "notification_destinations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_responses" ADD CONSTRAINT "notification_responses_notification_id_notifications_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_responses" ADD CONSTRAINT "notification_responses_responded_by_user_id_user_id_fkey" FOREIGN KEY ("responded_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification_responses" ADD CONSTRAINT "notification_responses_VPErICy2DEGZ_fkey" FOREIGN KEY ("destination_id") REFERENCES "notification_destinations"("id") ON DELETE SET NULL;