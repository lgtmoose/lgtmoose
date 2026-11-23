import { sql, type SQL } from "drizzle-orm";

/**
 * Whether a finding was raised in shadow mode, never posted, and nobody answered it since
 * (NIC-1141), as a condition on a query over `findings`. Such a finding has no thread anyone
 * could see, reply to or resolve: a live run retires it, and the dashboard stops counting it once
 * the deployment is live.
 *
 * - **Never posted:** our own finding, open or outdated, with no comment. A comment deleted on
 *   GitHub since keeps its ID here, so a live finding whose comment is gone doesn't match.
 * - **Raised in shadow mode:** the run that last raised it (`findings.run_id`) was a shadow run
 *   (`review_runs.shadow`: set by its post step, shadow by default).
 * - **Unanswered:** no event by a person (one with a login: a reply on its thread, a resolve, a
 *   decline from the findings CLI or dashboard) after its latest `raised` event. An answer from
 *   before it was raised again was about the earlier finding. A fix claim (NIC-1140) isn't an
 *   answer: only the recheck's word closes the finding, and a claim it rejects leaves it as
 *   unanswered as before.
 */
export function unpostedShadow(): SQL {
  // Columns are written out with their table: in a correlated subquery, drizzle's unqualified
  // names in an UPDATE would bind to the inner table.
  return sql`(
    "findings"."source" = 'self'
    and "findings"."status" in ('open', 'outdated')
    and "findings"."github_comment_id" is null
    and exists (
      select 1 from "review_runs" as shadow_run
      where shadow_run.id = "findings"."run_id" and shadow_run.shadow = true
    )
    and not exists (
      select 1 from "finding_events" as answer
      where answer.finding_id = "findings"."id"
        and answer.human
        and answer.type <> 'fix_claimed'
        and answer.created_at > coalesce(
          (
            select max(raise.created_at) from "finding_events" as raise
            where raise.finding_id = "findings"."id" and raise.type = 'raised'
          ),
          '-infinity'::timestamptz
        )
    )
  )`;
}

/**
 * Findings retired from shadow mode (status `shadow`) since the PR's last full review, as a
 * condition on `findings`: the summary asks for a full review to raise any still there. One raised
 * again is open again, so no longer counts; once a full review has run in full (`complete`: no
 * failed or spend-capped batch, nothing left unreviewed), none do. `finishReview` leaves the
 * note off such a review's own summary by the same test.
 */
export function retiredSinceFullReview(): SQL {
  return sql`(
    "findings"."status" = 'shadow'
    and (
      select max(retire.created_at) from "finding_events" as retire
      where retire.finding_id = "findings"."id" and retire.type = 'shadow_retired'
    ) > coalesce(
      (
        select max(full_run.finished_at) from "review_runs" as full_run
        where full_run.pull_request_id = "findings"."pull_request_id"
          and full_run.kind = 'full'
          and full_run.status = 'succeeded'
          and full_run.complete = true
      ),
      '-infinity'::timestamptz
    )
  )`;
}
