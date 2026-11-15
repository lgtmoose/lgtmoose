import pg from "pg";

/**
 * The database login the docker compose gateway uses (NIC-843). On AWS the internet-facing
 * gateway holds only the webhook secret; here it needs the database to queue jobs, so it gets a
 * role that can only add jobs to `job_queue`: INSERT, SELECT on the `id` it gets back and the
 * deduplication columns, and the id sequence. It can't read a job's body, any other table, or
 * change or delete anything.
 *
 * The runner calls this after the migrations, with the password from the compose `.env`. The
 * role is created once and its password set on every start, so changing it in `.env` takes
 * effect on the next start.
 */
export const GATEWAY_ROLE = "lgtmoose_gateway";

export async function ensureGatewayRole(
  client: Pick<pg.Client, "query">,
  password: string,
  role = GATEWAY_ROLE,
): Promise<void> {
  if (password.length < 16)
    throw new Error("The gateway's database password must be 16+ characters.");
  const name = pg.escapeIdentifier(role);
  const secret = pg.escapeLiteral(password);
  const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
  if (exists.rowCount === 0) {
    await client.query(`create role ${name} login password ${secret}`);
  } else {
    await client.query(`alter role ${name} login password ${secret}`);
  }
  await client.query(`revoke all on all tables in schema public from ${name}`);
  await client.query(`revoke all on all sequences in schema public from ${name}`);
  await client.query(`grant usage on schema public to ${name}`);
  await client.query(`grant insert on table job_queue to ${name}`);
  // `send` is `insert ... on conflict (queue, dedupe_id) do nothing returning id`: RETURNING
  // needs SELECT on `id`, and the conflict target needs SELECT on its columns. Not on `body`.
  await client.query(`grant select (id, queue, dedupe_id) on table job_queue to ${name}`);
  await client.query(`grant usage on sequence job_queue_id_seq to ${name}`);
}
