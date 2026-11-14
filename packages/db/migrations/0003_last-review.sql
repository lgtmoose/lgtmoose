ALTER TABLE "pull_requests" ADD COLUMN "last_review_event" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "last_review_id" bigint;