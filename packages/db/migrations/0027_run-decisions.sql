ALTER TABLE "review_runs" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "decision_blocking" integer;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "decision_should_fix" integer;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "decision_nits" integer;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "decision_holds" text[];--> statement-breakpoint
-- Runs from before the decision was kept: what the review they posted or recorded said, where
-- there is one. A quiet run recorded none, so its decision stays unknown (null), as do the
-- counts and holds of every older run.
UPDATE "review_runs" SET "decision" = CASE "review_event" WHEN 'APPROVE' THEN 'approve' WHEN 'REQUEST_CHANGES' THEN 'request_changes' WHEN 'COMMENT' THEN 'comment' END WHERE "status" = 'succeeded' AND "review_event" IS NOT NULL;
