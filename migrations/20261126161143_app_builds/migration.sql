CREATE TABLE "app_build_logs" (
	"build_id" text,
	"seq" integer,
	"stream" text NOT NULL,
	"text" text NOT NULL,
	"at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_build_logs_pkey" PRIMARY KEY("build_id","seq")
);
--> statement-breakpoint
CREATE TABLE "app_builds" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"seq" integer NOT NULL,
	"commit" text NOT NULL,
	"message" text NOT NULL,
	"mode" text NOT NULL,
	"trigger" text NOT NULL,
	"actor" text,
	"status" text NOT NULL,
	"expected_generation" text,
	"allow_destructive_data_migration" boolean DEFAULT false NOT NULL,
	"data_migration_approval_token" text,
	"notify_on_finish" boolean DEFAULT false NOT NULL,
	"request_id" text,
	"builder_id" text,
	"lease_expires_at" timestamp(3) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"log_seq" integer DEFAULT 0 NOT NULL,
	"artifact_sha256" text,
	"build_metadata" jsonb,
	"error_code" text,
	"error_message" text,
	"deployment_version" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "build_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "build_origin" text;--> statement-breakpoint
CREATE UNIQUE INDEX "app_builds_app_seq_idx" ON "app_builds" ("app_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "app_builds_app_request_idx" ON "app_builds" ("app_id","request_id") WHERE "request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "app_builds_one_building_idx" ON "app_builds" ("app_id") WHERE "status" = 'building';--> statement-breakpoint
CREATE INDEX "app_builds_app_created_idx" ON "app_builds" ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "app_builds_active_idx" ON "app_builds" ("status","created_at") WHERE "status" in ('queued', 'awaiting_artifact', 'building', 'verifying', 'releasing');--> statement-breakpoint
ALTER TABLE "app_build_logs" ADD CONSTRAINT "app_build_logs_build_id_app_builds_id_fkey" FOREIGN KEY ("build_id") REFERENCES "app_builds"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_builds" ADD CONSTRAINT "app_builds_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;