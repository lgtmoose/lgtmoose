ALTER TYPE "public"."finding_event_type" ADD VALUE 'shadow_retired';--> statement-breakpoint
ALTER TYPE "public"."finding_status" ADD VALUE 'shadow';--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "review_shadow" boolean;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "shadow" boolean;--> statement-breakpoint
-- Every run so far was in shadow mode: LGTMoose is alpha and shadow mode is the default, and no
-- install has run live yet. docs/upgrading.md says how to mark them live if yours did.
UPDATE "review_runs" SET "shadow" = true;
