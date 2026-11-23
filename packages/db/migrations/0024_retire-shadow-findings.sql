ALTER TYPE "public"."finding_event_type" ADD VALUE 'shadow_retired';--> statement-breakpoint
ALTER TYPE "public"."finding_status" ADD VALUE 'shadow';--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "raised_in_shadow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Findings raised before this migration: a run in shadow mode posted no GitHub review, so it has
-- no review ID, and its findings have no comment. A live run that raises findings posts a review
-- (findings outside the diff go in its body), so it has one. Only open and outdated findings
-- matter: closed ones are never retired.
UPDATE "findings" SET "raised_in_shadow" = true
WHERE "source" = 'self'
  AND "github_comment_id" IS NULL
  AND "status" IN ('open', 'outdated')
  AND "run_id" IN (
    SELECT "id" FROM "review_runs" WHERE "status" = 'succeeded' AND "review_id" IS NULL
  );
