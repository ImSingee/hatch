CREATE TABLE "app_task_run_steps" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_task_runs" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"task_name" text NOT NULL,
	"deployment_id" text,
	"version" integer,
	"trigger" text NOT NULL,
	"cron_name" text,
	"actor" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"log" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_task_run_steps_run_seq_attempt_idx" ON "app_task_run_steps" ("run_id","seq","attempt");--> statement-breakpoint
CREATE INDEX "app_task_runs_app_created_idx" ON "app_task_runs" ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "app_task_runs_app_task_created_idx" ON "app_task_runs" ("app_id","task_name","created_at");--> statement-breakpoint
CREATE INDEX "app_task_runs_active_idx" ON "app_task_runs" ("status","created_at") WHERE "status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "app_task_run_steps" ADD CONSTRAINT "app_task_run_steps_run_id_app_task_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "app_task_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_task_runs" ADD CONSTRAINT "app_task_runs_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;