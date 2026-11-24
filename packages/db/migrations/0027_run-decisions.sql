ALTER TABLE "review_runs" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "decision_blocking" integer;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "decision_should_fix" integer;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "decision_nits" integer;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "decision_holds" text[];--> statement-breakpoint
-- Runs from before the decision was kept: what the review they posted or recorded says, where
-- that's certain. APPROVE is approve and REQUEST_CHANGES is changes requested. COMMENT came from
-- three outcomes: comment (labelled changes or pending), approve with gate.approve false
-- (labelled approved), and a skipped decision (no label). The label tells them apart only while
-- it's a default one ("Requires Changes", "Ready for Review", "Approved"): a repository's own
-- labels, and a skipped run, leave the decision unknown (null), as do every older run's counts
-- and holds, and a quiet run, which recorded no review.
UPDATE "review_runs" SET "decision" = CASE
  WHEN "review_event" = 'APPROVE' THEN 'approve'
  WHEN "review_event" = 'REQUEST_CHANGES' THEN 'request_changes'
  WHEN "review_event" = 'COMMENT' AND "status_label" IN ('Requires Changes', 'Ready for Review') THEN 'comment'
  WHEN "review_event" = 'COMMENT' AND "status_label" = 'Approved' THEN 'approve'
END WHERE "status" = 'succeeded' AND "review_event" IS NOT NULL;
