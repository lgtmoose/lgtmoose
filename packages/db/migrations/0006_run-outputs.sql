ALTER TABLE "review_runs" ADD COLUMN "status_label" text;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "review_event" text;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "review_id" bigint;