ALTER TABLE "notification_revisions" ADD COLUMN "format" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_revisions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "notification_revisions" ADD COLUMN "markdown" text;--> statement-breakpoint
ALTER TABLE "notification_revisions" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "format" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "markdown" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_revisions" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
-- #319 cards become card notifications. These helpers write exactly what
-- `legacyToContent` and `summaryFromTitle` (packages/hatch-platform-api)
-- write; notification-content-migration.test.ts checks that they agree.
-- `textToInline`: lines joined by br nodes, runs of spaces, tabs, CR and FF
-- one space, each line trimmed, empty strings dropped.
CREATE FUNCTION "hatch_migration_text_to_inline"(input text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_agg(part.item ORDER BY line.n, part.sub), '[]'::jsonb)
  FROM regexp_split_to_table(input, E'\r?\n') WITH ORDINALITY AS line(text, n)
  CROSS JOIN LATERAL (
    SELECT 0 AS sub, '{"type":"br"}'::jsonb AS item WHERE line.n > 1
    UNION ALL
    SELECT 1, to_jsonb(segment.text)
    FROM (
      SELECT btrim(regexp_replace(line.text, E'[ \t\r\f]+', ' ', 'g'), ' ') AS text
    ) AS segment
    WHERE segment.text <> ''
  ) AS part
$$;--> statement-breakpoint
-- A tree node, without `props` or `children` when they are empty.
CREATE FUNCTION "hatch_migration_element"(type text, props jsonb, children jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('type', type)
    || CASE WHEN props IS NULL OR props = '{}'::jsonb THEN '{}'::jsonb
         ELSE jsonb_build_object('props', props) END
    || CASE WHEN children IS NULL OR children = '[]'::jsonb THEN '{}'::jsonb
         ELSE jsonb_build_object('children', children) END
$$;--> statement-breakpoint
-- `summaryFromTitle`: line breaks and runs of spaces, tabs and FF one space,
-- trimmed like String.prototype.trim, at most 200 characters.
CREATE FUNCTION "hatch_migration_summary"(title text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN char_length(line.text) > 200
    THEN left(line.text, 199) || E'…' ELSE line.text END
  FROM (
    SELECT regexp_replace(
      regexp_replace(regexp_replace(title, E'[\r\n]+', ' ', 'g'), E'[ \t\f]+', ' ', 'g'),
      E'^[\t\n\u000B\f\r    -     　﻿]+|[\t\n\u000B\f\r    -     　﻿]+$',
      '', 'g'
    ) AS text
  ) AS line
$$;--> statement-breakpoint
-- `blockToContent`: the #319 block as a tree node; `tone` is the status tone.
CREATE FUNCTION "hatch_migration_block"(block jsonb, tone text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE block->>'type'
    WHEN 'progress' THEN "hatch_migration_element"(
      'Progress',
      jsonb_strip_nulls(jsonb_build_object(
        'label', block->'label',
        'value', CASE WHEN block->>'value' <> '' THEN block->'value' END,
        'percent', block->'percent',
        'tone', CASE WHEN tone <> 'neutral' THEN to_jsonb(tone) END
      )),
      NULL
    )
    WHEN 'stats' THEN (
      SELECT CASE
        WHEN count(*) = 1 THEN (array_agg(stat.node))[1]
        ELSE "hatch_migration_element"(
          'Grid',
          CASE WHEN count(*) = 2 THEN NULL
            ELSE jsonb_build_object('columns', count(*)) END,
          jsonb_agg(stat.node ORDER BY stat.n)
        )
      END
      FROM (
        SELECT item.n, "hatch_migration_element"(
          'Stat',
          jsonb_strip_nulls(jsonb_build_object(
            'value', item.value->'value',
            'label', item.value->'label'
          )),
          NULL
        ) AS node
        FROM jsonb_array_elements(coalesce(block->'items', '[]'::jsonb))
          WITH ORDINALITY AS item(value, n)
      ) AS stat
    )
    WHEN 'quote' THEN "hatch_migration_element"(
      'Quote',
      jsonb_strip_nulls(jsonb_build_object(
        'author', block->'author',
        'location', CASE WHEN block->>'location' <> '' THEN block->'location' END
      )),
      "hatch_migration_text_to_inline"(block->>'text')
    )
  END
$$;--> statement-breakpoint
-- `legacyToContent`: a Card with the status, then the title, body and block.
CREATE FUNCTION "hatch_migration_card"(title text, body text, card jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT "hatch_migration_element"(
    'Card',
    CASE WHEN jsonb_typeof(card->'status') = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
      'status', card->'status'->'label',
      'tone', CASE WHEN card->'status'->>'tone' <> 'neutral' THEN card->'status'->'tone' END
    )) END,
    (
      SELECT jsonb_agg(child.node ORDER BY child.n)
      FROM (VALUES
        (1, "hatch_migration_element"('Title', NULL, "hatch_migration_text_to_inline"(title))),
        (2, CASE WHEN "hatch_migration_text_to_inline"(body) <> '[]'::jsonb
          THEN "hatch_migration_element"('Text', NULL, "hatch_migration_text_to_inline"(body)) END),
        (3, CASE WHEN jsonb_typeof(card->'block') = 'object'
          THEN "hatch_migration_block"(
            card->'block',
            CASE WHEN jsonb_typeof(card->'status') = 'object' THEN card->'status'->>'tone' END
          ) END)
      ) AS child(n, node)
      WHERE child.node IS NOT NULL
    )
  )
$$;--> statement-breakpoint
UPDATE "notifications" SET
  "format" = 'card',
  "content" = "hatch_migration_card"("title", "body", "card"),
  "summary" = "hatch_migration_summary"("title"),
  "title" = NULL,
  "body" = NULL
WHERE jsonb_typeof("card") = 'object';--> statement-breakpoint
UPDATE "notification_revisions" SET
  "format" = 'card',
  "content" = "hatch_migration_card"("title", "body", "card"),
  "summary" = "hatch_migration_summary"("title"),
  "title" = NULL,
  "body" = NULL
WHERE jsonb_typeof("card") = 'object';--> statement-breakpoint
DROP FUNCTION "hatch_migration_card"(text, text, jsonb);--> statement-breakpoint
DROP FUNCTION "hatch_migration_block"(jsonb, text);--> statement-breakpoint
DROP FUNCTION "hatch_migration_summary"(text);--> statement-breakpoint
DROP FUNCTION "hatch_migration_element"(text, jsonb, jsonb);--> statement-breakpoint
DROP FUNCTION "hatch_migration_text_to_inline"(text);--> statement-breakpoint
ALTER TABLE "notification_revisions" ADD CONSTRAINT "notification_revisions_content_check" CHECK ((
    ("notification_revisions"."format" = 'text' and "notification_revisions"."title" is not null and "notification_revisions"."markdown" is null and "notification_revisions"."content" is null)
    or ("notification_revisions"."format" in ('markdown', 'card') and "notification_revisions"."title" is null and "notification_revisions"."body" is null and "notification_revisions"."summary" is not null and "notification_revisions"."content" is not null
      and ("notification_revisions"."format" = 'markdown') = ("notification_revisions"."markdown" is not null))
  ));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_content_check" CHECK ((
    ("notifications"."format" = 'text' and "notifications"."title" is not null and "notifications"."markdown" is null and "notifications"."content" is null)
    or ("notifications"."format" in ('markdown', 'card') and "notifications"."title" is null and "notifications"."body" is null and "notifications"."summary" is not null and "notifications"."content" is not null
      and ("notifications"."format" = 'markdown') = ("notifications"."markdown" is not null))
  ));--> statement-breakpoint
ALTER TABLE "notification_revisions" DROP COLUMN "card";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "card";
