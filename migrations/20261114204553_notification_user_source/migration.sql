ALTER TABLE "notifications" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_idx" ON "notifications" ("user_id","dedupe_key") WHERE "notifications"."user_id" is not null and "notifications"."dedupe_key" is not null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_source_check", ADD CONSTRAINT "notifications_source_check" CHECK ((
        ("notifications"."source_type" = 'app' and "notifications"."channel_id" is null and "notifications"."user_id" is null)
        or ("notifications"."source_type" = 'channel' and "notifications"."app_id" is null and "notifications"."user_id" is null)
        or ("notifications"."source_type" = 'platform' and "notifications"."app_id" is null and "notifications"."channel_id" is null and "notifications"."user_id" is null)
        or ("notifications"."source_type" = 'user' and "notifications"."app_id" is null and "notifications"."channel_id" is null)
      ));