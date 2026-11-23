import { sql, type SQL } from "drizzle-orm";

/**
 * Whether a finding was raised in shadow mode, never posted, and nobody answered it since
 * (NIC-1141), as a condition on a query over `findings`. Such a finding has no thread anyone
 * could see, reply to or resolve: a live run retires it, and the dashboard stops counting it once
 * the deployment is live.
 *
 * - **Never posted:** our own finding, open or outdated, with no comment. A comment deleted on
 *   GitHub since keeps its ID here, so a live finding whose comment is gone doesn't match.
 * - **Raised in shadow mode:** the run that last raised it (`findings.run_id`) was a shadow run.
 *   Runs record that from the start (`review_runs.shadow`). One recorded before that, or by
 *   control code older than the column, counts as shadow when it succeeded without a review ID:
 *   a live run that raised findings posted a review (findings outside the diff go in its body).
 * - **Unanswered:** no event by a person (one with a login: a reply on its thread, a resolve, an
 *   answer from the findings CLI or dashboard) after its latest `raised` event. An answer from
 *   before it was raised again was about the earlier finding.
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
      where shadow_run.id = "findings"."run_id"
        and (
          shadow_run.shadow = true
          or (
            shadow_run.shadow is null
            and shadow_run.status = 'succeeded'
            and shadow_run.review_id is null
          )
        )
    )
    and not exists (
      select 1 from "finding_events" as answer
      where answer.finding_id = "findings"."id"
        and answer.actor_login is not null
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
