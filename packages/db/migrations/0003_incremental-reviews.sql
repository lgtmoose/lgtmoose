ALTER TYPE "public"."finding_event_type" ADD VALUE 'cleared';--> statement-breakpoint
ALTER TYPE "public"."finding_status" ADD VALUE 'cleared';--> statement-breakpoint
ALTER TABLE "files_reviewed" ADD COLUMN "base_blob_sha" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "last_review_event" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "last_review_id" bigint;