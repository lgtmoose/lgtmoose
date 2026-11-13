import { readSandboxEnv } from "./env.js";

/**
 * Entry point of the sandbox task. The Workflow stack (NIC-810) defines the task; the review
 * workflow that runs a batch here comes with NIC-811. Until then it checks its settings and
 * stops with an error, so a misconfigured task definition shows in the logs. It never prints a
 * credential.
 */
const env = readSandboxEnv(process.env);
process.stderr.write(
  "missing" in env
    ? `Missing environment variables: ${env.missing.join(", ")}\n`
    : "The sandbox task's batch run isn't implemented until NIC-811 (Step Functions review workflow).\n",
);
process.exitCode = 1;
