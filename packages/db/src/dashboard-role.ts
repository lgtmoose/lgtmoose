import pg from "pg";

/**
 * The database login the docker compose dashboard uses (NIC-1056). On AWS the dashboard Lambda
 * reads the database as the owner and the feedback report through an IAM grant on that one S3
 * key; here it gets a role with only what the dashboard store and the learning policy use:
 *
 * - reads of pull requests, findings, review runs, provider use and cooldowns, learnings and the
 *   spend ledger (NIC-1079, for the Usage page's spend against the caps);
 * - its own sessions in `dashboard_sessions` (create, read, delete);
 * - asking for a bootstrap from review history: INSERT and SELECT on `learning_bootstraps`, and
 *   reading `learning_bootstrap_items` (NIC-1080);
 * - approving or retiring a learning: UPDATE of `status`, `updated_at` and `retired_at` on
 *   `learnings`, and INSERT on `learning_events`. Whether a person may is decided by
 *   `approveLearning` and `forgetLearning` from what GitHub said at sign-in, as on AWS;
 * - which learnings weren't followed (NIC-1081): SELECT of `learning_id`, `type` and
 *   `created_at` on `learning_events`, not who did what;
 * - the feedback report, through the `dashboard_feedback_report` view of that one artifact, not
 *   the `artifacts` table, which holds transcripts and run data;
 * - answering a finding (NIC-1140): UPDATE of `status`, `updated_at`, `fix_claimed_at` and
 *   `fix_claimed_by` on `findings`, and INSERT on `finding_events`.
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
  // A bootstrap's proposed learnings and their sources (NIC-1080).
  "learning_bootstrap_items",
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
  // Asking for a bootstrap from review history (NIC-1080): a new row, and reading them. The
  // control task and the reconciler run it; the dashboard can't change one once asked.
  await client.query(`grant select, insert on table learning_bootstraps to ${name}`);
  // What the learnings page counts (NIC-1081): which learning, what happened, and when. Not who.
  await client.query(
    `grant select (learning_id, type, created_at) on table learning_events to ${name}`,
  );
  await client.query(`grant select on table ${DASHBOARD_REPORT_VIEW} to ${name}`);
  // Answering a finding (NIC-1140): a fix claim, or a decline, and its event. Whether a person
  // may is decided from GitHub (write access, and the author rule for a decline).
  await client.query(
    `grant update (status, updated_at, fix_claimed_at, fix_claimed_by) on table findings to ${name}`,
  );
  await client.query(`grant insert on table finding_events to ${name}`);
}
