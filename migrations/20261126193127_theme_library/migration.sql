CREATE TABLE "themes" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "themes_name_idx" ON "themes" (lower("name"));