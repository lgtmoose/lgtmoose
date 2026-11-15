import pg from "pg";

/**
 * The database login the docker compose dashboard uses (NIC-1056). On AWS the dashboard Lambda
 * reads the database as the owner and the feedback report through an IAM grant on that one S3
 * key; here it gets a role with only what the dashboard store and the learning policy use:
 *
 * - reads of pull requests, findings, review runs, provider use and cooldowns, learnings and the
 *   spend ledger (NIC-1079, for the Usage page's spend against the caps);
 * - its own sessions in `dashboard_sessions` (create, read, delete);
 * - approving or retiring a learning: UPDATE of `status`, `updated_at` and `retired_at` on
 *   `learnings`, and INSERT on `learning_events`. Whether a person may is decided by
 *   `approveLearning` and `forgetLearning` from what GitHub said at sign-in, as on AWS;
 * - the feedback report, through the `dashboard_feedback_report` view of that one artifact, not
 *   the `artifacts` table, which holds transcripts and run data.
 *
 * Nothing else: not the job queue, executions, artifacts, feedback rows or any delete but its
 * own sessions'. The runner calls this after the migrations, as `ensureGatewayRole`, so the
 * password from the compose `.env` and the grants are applied again on every start.
 */
export const DASHBOARD_ROLE = "lgtmoose_dashboard";
/** The one artifact the dashboard reads: the feedback report (`FEEDBACK_REPORT_KEY`). */
export const DASHBOARD_REPORT_VIEW = "dashboard_feedback_report";

const READS = [
  "pull_requests",
  "findings",
  "review_runs",
  "provider_usage",
  "provider_cooldowns",
  "learnings",
  "spend_ledger",
] as const;

export async function ensureDashboardRole(
  client: Pick<pg.Client, "query">,
  password: string,
  options: { reportKey: string; role?: string },
): Promise<void> {
  if (password.length < 16) {
    throw new Error("The dashboard's database password must be 16+ characters.");
  }
  const role = options.role ?? DASHBOARD_ROLE;
  const name = pg.escapeIdentifier(role);
  const secret = pg.escapeLiteral(password);
  const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
  if (exists.rowCount === 0) {
    await client.query(`create role ${name} login password ${secret}`);
  } else {
    await client.query(`alter role ${name} login password ${secret}`);
  }
  // A view runs with its owner's rights: the role reads this row of `artifacts` and no other.
  await client.query(
    `create or replace view ${DASHBOARD_REPORT_VIEW} as
       select body, updated_at from artifacts where key = ${pg.escapeLiteral(options.reportKey)}`,
  );
  await client.query(`revoke all on all tables in schema public from ${name}`);
  await client.query(`revoke all on all sequences in schema public from ${name}`);
  await client.query(`grant usage on schema public to ${name}`);
  for (const table of READS) await client.query(`grant select on table ${table} to ${name}`);
  await client.query(`grant select, insert, delete on table dashboard_sessions to ${name}`);
  await client.query(`grant update (status, updated_at, retired_at) on table learnings to ${name}`);
  await client.query(`grant insert on table learning_events to ${name}`);
  await client.query(`grant select on table ${DASHBOARD_REPORT_VIEW} to ${name}`);
}
