ALTER TYPE "public"."finding_event_type" ADD VALUE 'fix_claimed';--> statement-breakpoint
ALTER TABLE "finding_events" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "finding_events" ADD COLUMN "learn_pending" boolean;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "fix_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "fix_claimed_by" text;--> statement-breakpoint
CREATE INDEX "finding_events_learn_pending_idx" ON "finding_events" USING btree ("created_at") WHERE "finding_events"."learn_pending";