ALTER TYPE "public"."finding_event_type" ADD VALUE 'shadow_retired';--> statement-breakpoint
ALTER TYPE "public"."finding_status" ADD VALUE 'shadow';--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "shadow" boolean;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "shadow_retired" integer;