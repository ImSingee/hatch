ALTER TABLE "workflow_deployments" DROP CONSTRAINT "workflow_deployments_workflow_id_workflows_id_fk";--> statement-breakpoint
ALTER TABLE "workflow_run_steps" DROP CONSTRAINT "workflow_run_steps_run_id_workflow_runs_id_fk";--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk";--> statement-breakpoint
DROP TABLE "workflow_deployments";--> statement-breakpoint
DROP TABLE "workflow_run_steps";--> statement-breakpoint
DROP TABLE "workflow_runs";--> statement-breakpoint
DROP TABLE "workflows";