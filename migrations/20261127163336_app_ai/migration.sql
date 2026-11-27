CREATE TABLE "app_ai_role_bindings" (
	"app_id" text,
	"role" text,
	"model_row_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_ai_role_bindings_pkey" PRIMARY KEY("app_id","role")
);
--> statement-breakpoint
CREATE TABLE "app_ai_usage" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"deployment_id" text,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"provider_name" text NOT NULL,
	"model_id" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_ai_usage_app_created_idx" ON "app_ai_usage" ("app_id","created_at");--> statement-breakpoint
ALTER TABLE "app_ai_role_bindings" ADD CONSTRAINT "app_ai_role_bindings_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_ai_role_bindings" ADD CONSTRAINT "app_ai_role_bindings_model_row_id_agent_models_id_fkey" FOREIGN KEY ("model_row_id") REFERENCES "agent_models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_ai_usage" ADD CONSTRAINT "app_ai_usage_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;