ALTER TYPE "public"."finding_event_type" ADD VALUE 'shadow_retired';--> statement-breakpoint
ALTER TYPE "public"."finding_status" ADD VALUE 'shadow';--> statement-breakpoint
ALTER TABLE "finding_events" ADD COLUMN "human" boolean GENERATED ALWAYS AS (actor_login is not null) STORED;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "review_shadow" boolean;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "shadow" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "complete" boolean;
-- The column's default fills every existing row with true: every run so far was in shadow mode
-- (LGTMoose is alpha and shadow mode is the default), and runs of older control code still
-- finishing during the deploy never record their mode. docs/upgrading.md says how to mark an
-- install's live runs live.
