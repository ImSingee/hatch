-- Keep activity times to the millisecond, like the JavaScript Date the read
-- position and the timeline cursor are written from. Truncating (not
-- rounding) existing values matches positions already saved from them.
ALTER TABLE "notifications" ALTER COLUMN "activity_at" SET DATA TYPE timestamp(3) with time zone USING date_trunc('milliseconds', "activity_at")::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "notification_read_cursors" ALTER COLUMN "activity_at" SET DATA TYPE timestamp(3) with time zone USING date_trunc('milliseconds', "activity_at")::timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "notification_revisions" ALTER COLUMN "activity_at" SET DATA TYPE timestamp(3) with time zone USING date_trunc('milliseconds', "activity_at")::timestamp(3) with time zone;