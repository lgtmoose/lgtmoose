ALTER TABLE "files_reviewed" ADD COLUMN "base_blob_sha" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "last_review_event" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "last_review_id" bigint;