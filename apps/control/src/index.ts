import { readControlEnv } from "./env.js";

/**
 * Entry point of the control task. The Workflow stack (NIC-810) defines the task; the review
 * workflow that runs it (the prepare and post steps) comes with NIC-811. Until then it checks
 * its settings and stops with an error, so a misconfigured task definition shows in the logs.
 */
const env = readControlEnv(process.env);
process.stderr.write(
  "missing" in env
    ? `Missing environment variables: ${env.missing.join(", ")}\n`
    : "The control task's steps aren't implemented until NIC-811 (Step Functions review workflow).\n",
);
process.exitCode = 1;
