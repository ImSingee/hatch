-- The accent, dock labels, App pins and dashboard pins/order become per user.
-- Every existing user starts from what the instance showed before, so nobody's
-- screen changes; users created later start from the built-in defaults.

-- 1. Theme: each user gets the instance `ui.theme`, field by field. A field
-- that is missing or holds the wrong type stays null (the built-in default),
-- as the old reader fell back per field; the service drops a retired accent.
ALTER TABLE "user_preferences" ADD COLUMN "accent" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "dock_labels" boolean;--> statement-breakpoint
INSERT INTO "user_preferences" ("user_id", "homepage", "accent", "dock_labels")
SELECT
  "user"."id",
  -- A first preference row needs a homepage: the default one users get
  -- without a row (`DEFAULT_HOMEPAGE`).
  '{"kind":"page","page":"dashboard"}'::jsonb,
  "theme"."accent",
  "theme"."dock_labels"
FROM "user"
CROSS JOIN (
  SELECT
    CASE WHEN jsonb_typeof("value" -> 'accent') = 'string'
      THEN "value" ->> 'accent' END AS "accent",
    CASE WHEN jsonb_typeof("value" -> 'dockLabels') = 'boolean'
      THEN ("value" -> 'dockLabels')::boolean END AS "dock_labels"
  FROM "platform_config"
  WHERE "key" = 'ui.theme' AND jsonb_typeof("value") = 'object'
) AS "theme"
ON CONFLICT ("user_id") DO UPDATE SET
  "accent" = excluded."accent",
  "dock_labels" = excluded."dock_labels";--> statement-breakpoint
DELETE FROM "platform_config" WHERE "key" = 'ui.theme';--> statement-breakpoint

-- 2. App pins: every user gets a copy of every pin, in the same order. Each
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
ALTER TABLE "sidebar_items" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sidebar_items" ADD CONSTRAINT "sidebar_items_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "sidebar_items_user_order_idx" ON "sidebar_items" ("user_id","sort_order");--> statement-breakpoint

-- 3. Dashboards stay shared; each user gets the instance pinned flag and order
-- of every dashboard. The shared columns go once they are copied.
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
ALTER TABLE "dashboards" DROP COLUMN "pinned";--> statement-breakpoint
ALTER TABLE "dashboards" DROP COLUMN "sort_order";
