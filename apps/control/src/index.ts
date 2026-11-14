import { SFNClient } from "@aws-sdk/client-sfn";
import { awsControlDeps } from "./aws.js";
import { describeStatus, errorName, isDeadToken, sendHeartbeat } from "./sfn.js";
import { readCommand, readControlEnv, readReviewSettings } from "./env.js";
import { runCommand } from "./run.js";

/**
 * Entry point of the control task. The review state machine starts it once per step, with
 * `LGTMOOSE_COMMAND` (prepare, post or fail) and the step's inputs as container overrides.
 * Errors are printed as messages only; no step puts a credential in one.
 */
async function main(): Promise<void> {
  const env = readControlEnv(process.env);
  if ("missing" in env) {
    throw new Error(`Missing environment variables: ${env.missing.join(", ")}`);
  }
  const command = readCommand(process.env);
  const settings = readReviewSettings(process.env);
  const sfn = new SFNClient({});
  // The heartbeat clock started when the step scheduled the task: beat before the slow setup
  // (secrets, the database) so a cold start doesn't use it up. The step beats on from there.
  // A dead token means this attempt no longer counts (a retry has the step, or the execution
  // was stopped) and nothing has been done yet: stop now rather than race the retry.
  if (command.command !== "fail") {
    try {
      await sendHeartbeat(sfn, command.taskToken);
    } catch (error) {
      if (isDeadToken(error)) {
        process.stdout.write(
          `${JSON.stringify({ message: "task token dead at start; exiting" })}\n`,
        );
        return;
      }
      process.stderr.write(`early heartbeat failed: ${errorName(error) ?? "unknown"}\n`);
    }
  }
  const deps = await awsControlDeps(env, { shadow: settings.shadow });
  try {
    await runCommand(
      {
        ...deps,
        executionStatus: (arn) => describeStatus(sfn, arn),
        heartbeat: (token) => sendHeartbeat(sfn, token),
      },
      command,
      settings,
    );
  } finally {
    await deps.close();
  }
}

// Exit once the step is done: an attempt that gave up (see StepAbandoned) may still have work
// in flight, such as a clone, that must not carry on.
main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
