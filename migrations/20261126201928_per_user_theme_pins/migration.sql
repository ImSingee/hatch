-- The active theme, accent, dock labels, App pins and dashboard pins/order
-- become per user; the theme library (`themes`) stays shared. Every existing
-- user starts from what the instance showed before, so nobody's screen
-- changes; users created later start from the built-in defaults.

-- 1. Theme: each user gets the instance `ui.theme`, field by field, read the
-- way the instance setting was read:
-- - accent: a string is copied (the service reads a retired name as the
--   default accent); JSON null means no accent; missing or another type was
--   the default accent (`indigo`, tokens.json `defaultAccent`).
-- - dockLabels: a boolean is copied; anything else stays null (off).
-- - theme: a custom theme's id goes to `custom_theme_id`, whose foreign key
--   clears it when the theme is deleted; any other name to `theme_preset`
--   (the service draws `desk` for a name that is no preset). Missing, it
--   stays null: `desk`.
-- Without a `ui.theme` row the instance drew the defaults, which is what a
-- user without these columns set draws. The row itself stays (see step 3).
ALTER TABLE "user_preferences" ADD COLUMN "accent" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "dock_labels" boolean;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "theme_preset" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "custom_theme_id" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_custom_theme_id_themes_id_fkey" FOREIGN KEY ("custom_theme_id") REFERENCES "themes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "dashboard_defaults_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
INSERT INTO "user_preferences"
  ("user_id", "homepage", "accent", "dock_labels", "theme_preset", "custom_theme_id")
SELECT
  "user"."id",
  -- A first preference row needs a homepage: the default one users get
  -- without a row (`DEFAULT_HOMEPAGE`).
  '{"kind":"page","page":"dashboard"}'::jsonb,
  "theme"."accent",
  "theme"."dock_labels",
  CASE WHEN "custom"."id" IS NULL THEN "theme"."theme" END,
  "custom"."id"
FROM "user"
CROSS JOIN (
  SELECT
    CASE jsonb_typeof("value" -> 'accent')
      WHEN 'string' THEN "value" ->> 'accent'
      WHEN 'null' THEN NULL
      ELSE 'indigo' END AS "accent",
    CASE WHEN jsonb_typeof("value" -> 'dockLabels') = 'boolean'
      THEN ("value" -> 'dockLabels')::boolean END AS "dock_labels",
    CASE WHEN jsonb_typeof("value" -> 'theme') = 'string'
      THEN "value" ->> 'theme' END AS "theme"
  FROM "platform_config"
  WHERE "key" = 'ui.theme' AND jsonb_typeof("value") = 'object'
) AS "theme"
LEFT JOIN "themes" AS "custom" ON "custom"."id" = "theme"."theme"
ON CONFLICT ("user_id") DO UPDATE SET
  "accent" = excluded."accent",
  "dock_labels" = excluded."dock_labels",
  "theme_preset" = excluded."theme_preset",
  "custom_theme_id" = excluded."custom_theme_id";--> statement-breakpoint

-- 2. App pins: every user gets a copy of every pin, in the same order. `user_id`
-- stays nullable for one release: a server still on the previous release
-- inserts pins without it, and this release never sees such rows
-- (docs/database-cleanups.md). Each
-- copy needs its own id; a 26-character hex digest of the original id and the
-- user is shaped like the lowercase ULIDs the app mints. Without users there
-- is nobody to keep the pins for.
ALTER TABLE "sidebar_items" ADD COLUMN "user_id" text;--> statement-breakpoint
INSERT INTO "sidebar_items"
  ("id", "user_id", "app_id", "label", "icon", "entry_hash", "sort_order", "created_at")
SELECT
  substr(md5("sidebar_items"."id" || ':' || "user"."id"), 1, 26),
  "user"."id",
  "sidebar_items"."app_id",
  "sidebar_items"."label",
  "sidebar_items"."icon",
  "sidebar_items"."entry_hash",
  "sidebar_items"."sort_order",
  "sidebar_items"."created_at"
FROM "sidebar_items"
CROSS JOIN "user"
WHERE "sidebar_items"."user_id" IS NULL;--> statement-breakpoint
DELETE FROM "sidebar_items" WHERE "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "sidebar_items" ADD CONSTRAINT "sidebar_items_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "sidebar_items_user_order_idx" ON "sidebar_items" ("user_id","sort_order");--> statement-breakpoint

-- 3. Dashboards stay shared; each user gets the instance pinned flag and order
-- of every dashboard. The shared `dashboards.pinned` and `sort_order` stay one
-- more release, unused, so a server still on the previous release (a rolling
-- upgrade or a rollback) can read dashboards; so does the `ui.theme` row the
-- previous release draws. docs/database-cleanups.md tracks their removal.
CREATE TABLE "user_dashboards" (
	"user_id" text,
	"dashboard_id" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_dashboards_pkey" PRIMARY KEY("user_id","dashboard_id")
);
--> statement-breakpoint
ALTER TABLE "user_dashboards" ADD CONSTRAINT "user_dashboards_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_dashboards" ADD CONSTRAINT "user_dashboards_dashboard_id_dashboards_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "user_dashboards" ("user_id", "dashboard_id", "pinned", "sort_order")
SELECT "user"."id", "dashboards"."id", "dashboards"."pinned", "dashboards"."sort_order"
FROM "dashboards"
CROSS JOIN "user";--> statement-breakpoint

-- 4. A new user's first visit pins the default dashboard once. Users who
-- already see dashboards are past that visit: they keep exactly the pins
-- copied above. Users without a preference row get one, with the default
-- homepage. On an instance without dashboards, the first visit still creates
-- the default one pinned, as it did before.
INSERT INTO "user_preferences" ("user_id", "homepage", "dashboard_defaults_applied")
SELECT "user"."id", '{"kind":"page","page":"dashboard"}'::jsonb, true
FROM "user"
WHERE EXISTS (SELECT 1 FROM "dashboards")
ON CONFLICT ("user_id") DO UPDATE SET "dashboard_defaults_applied" = true;
