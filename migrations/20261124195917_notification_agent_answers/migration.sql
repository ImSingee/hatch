ALTER TABLE "notification_response_routes" ADD COLUMN "target_type" text DEFAULT 'destination' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD COLUMN "agent_instructions" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ALTER COLUMN "target_destination_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD CONSTRAINT "notification_response_routes_5CDPz6v9cxYl_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agent_session_id_agent_sessions_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification_response_routes" ADD CONSTRAINT "notification_response_routes_target_check" CHECK ((
        ("notification_response_routes"."target_type" = 'destination' and "notification_response_routes"."target_destination_id" is not null and "notification_response_routes"."agent_session_id" is null and "notification_response_routes"."agent_instructions" is null)
        or ("notification_response_routes"."target_type" = 'agent' and "notification_response_routes"."target_destination_id" is null)
      ));