ALTER TABLE "pull_request_dispatches" ADD COLUMN "review_count_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_request_dispatches" ADD COLUMN "review_request_head" text;--> statement-breakpoint
ALTER TABLE "pull_request_dispatches" ADD COLUMN "excluded_automatic_run_id" text;