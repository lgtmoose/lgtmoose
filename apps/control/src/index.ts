import { SFNClient } from "@aws-sdk/client-sfn";
import { awsControlDeps } from "./aws.js";
import { describeStatus, sendHeartbeat } from "./sfn.js";
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
  const deps = await awsControlDeps(env, { shadow: settings.shadow });
  try {
    const sfn = new SFNClient({});
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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
