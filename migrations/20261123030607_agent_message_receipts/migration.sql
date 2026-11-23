CREATE TABLE "agent_message_receipts" (
	"session_id" text,
	"client_message_id" text,
	"fingerprint" text NOT NULL,
	"pending_message_id" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_message_receipts_pkey" PRIMARY KEY("session_id","client_message_id")
);
--> statement-breakpoint
CREATE INDEX "agent_message_receipts_pending_idx" ON "agent_message_receipts" ("session_id","pending_message_id");--> statement-breakpoint
ALTER TABLE "agent_message_receipts" ADD CONSTRAINT "agent_message_receipts_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_message_receipts" ADD CONSTRAINT "agent_message_receipts_run_id_agent_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL;