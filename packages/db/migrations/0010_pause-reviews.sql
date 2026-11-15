ALTER TABLE "pull_request_dispatches" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_request_dispatches" ADD COLUMN "paused_by" text;