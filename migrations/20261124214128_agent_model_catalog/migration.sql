CREATE TABLE "model_catalog_snapshots" (
	"id" text PRIMARY KEY,
	"source_url" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL,
	"provider_count" integer NOT NULL,
	"model_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_models" ADD COLUMN "catalog_ref" text;--> statement-breakpoint
ALTER TABLE "agent_pending_messages" ADD COLUMN "thinking_level" text;--> statement-breakpoint
ALTER TABLE "agent_providers" ADD COLUMN "catalog_provider_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "thinking_level" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "thinking_level" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "agent_model" jsonb;--> statement-breakpoint
ALTER TABLE "agent_models" ALTER COLUMN "reasoning" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agent_models" ALTER COLUMN "reasoning" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_models" ALTER COLUMN "context_window" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agent_models" ALTER COLUMN "context_window" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_models" ALTER COLUMN "max_tokens" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agent_models" ALTER COLUMN "max_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_pending_messages" ADD CONSTRAINT "agent_pending_messages_thinking_level_check" CHECK ("agent_pending_messages"."thinking_level" in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_thinking_level_check" CHECK ("agent_runs"."thinking_level" in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_thinking_level_check" CHECK ("agent_sessions"."thinking_level" in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));--> statement-breakpoint
-- Link providers that point at a known vendor endpoint to the built-in
-- catalog. Their existing reasoning, context window and max tokens values
-- stay as explicit overrides; the catalog adds what Hatch never stored:
-- thinking levels and the request-format flags pi expects for the model.
UPDATE "agent_providers" SET "catalog_provider_id" = CASE rtrim(lower(btrim("base_url")), '/')
	WHEN 'https://api.openai.com/v1' THEN 'openai'
	WHEN 'https://api.anthropic.com' THEN 'anthropic'
	WHEN 'https://api.deepseek.com' THEN 'deepseek'
	WHEN 'https://api.deepseek.com/v1' THEN 'deepseek'
	WHEN 'https://openrouter.ai/api/v1' THEN 'openrouter'
	WHEN 'https://api.moonshot.ai/v1' THEN 'moonshotai'
	WHEN 'https://api.moonshot.cn/v1' THEN 'moonshotai-cn'
	WHEN 'https://api.x.ai/v1' THEN 'xai'
	WHEN 'https://api.z.ai/api/paas/v4' THEN 'zai'
	WHEN 'https://open.bigmodel.cn/api/paas/v4' THEN 'zhipuai'
	WHEN 'https://api.mistral.ai/v1' THEN 'mistral'
	WHEN 'https://ai-gateway.vercel.sh/v1' THEN 'vercel-ai-gateway'
END
WHERE "catalog_provider_id" IS NULL;--> statement-breakpoint
-- A reference the catalog does not contain is ignored at read time, so this
-- needs no catalog data.
UPDATE "agent_models" AS m SET "catalog_ref" = p."catalog_provider_id" || '/' || m."model_id"
FROM "agent_providers" AS p
WHERE m."provider_id" = p."id" AND p."catalog_provider_id" IS NOT NULL AND m."catalog_ref" IS NULL;
