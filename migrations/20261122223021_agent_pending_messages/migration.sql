CREATE TABLE "agent_pending_messages" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"user_id" text,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_run_id" text,
	"content" jsonb NOT NULL,
	"images" jsonb DEFAULT '[]' NOT NULL,
	"attachments" jsonb DEFAULT '[]' NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_pending_messages_mode_check" CHECK ("agent_pending_messages"."mode" in ('queue', 'steer')),
	CONSTRAINT "agent_pending_messages_status_check" CHECK ("agent_pending_messages"."status" in ('pending', 'claimed', 'injected', 'sending'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "pending_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "agent_message_mode" text DEFAULT 'steer' NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_pending_messages_session_idx" ON "agent_pending_messages" ("session_id","id");--> statement-breakpoint
ALTER TABLE "agent_pending_messages" ADD CONSTRAINT "agent_pending_messages_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_pending_messages" ADD CONSTRAINT "agent_pending_messages_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_pending_messages" ADD CONSTRAINT "agent_pending_messages_claimed_run_id_agent_runs_id_fkey" FOREIGN KEY ("claimed_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_agent_message_mode_check" CHECK ("user_preferences"."agent_message_mode" in ('queue', 'steer'));