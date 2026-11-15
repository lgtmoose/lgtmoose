ALTER TABLE "pull_request_dispatches" ADD COLUMN "checks_wait_sha" text;--> statement-breakpoint
ALTER TABLE "pull_request_dispatches" ADD COLUMN "checks_wait_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_request_dispatches" ADD COLUMN "checks_wait_state" text;