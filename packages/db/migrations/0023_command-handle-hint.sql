ALTER TABLE "pull_request_dispatches" ADD COLUMN "handle_hint_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_request_dispatches" ADD COLUMN "handle_hint_posted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_request_dispatches" ADD COLUMN "handle_hint_claimant" text;