import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  BOOTSTRAP_REQUEST_PREFIX,
  STACK_NAMES,
  STACK_OUTPUTS,
  type DeployConfig,
} from "@lgtmoose/config";
import type { StackLookup } from "../deploy/aws-cloudformation.js";
import { errorMessage } from "../errors.js";
import { CLI } from "../paths.js";

/** Merged PRs a bootstrap reads by default, and the most it may. */
const DEFAULT_PRS = 200;
const MAX_PRS = 1000;

export const LEARNINGS_HELP = `Usage: ${CLI} learnings bootstrap --repo <owner/name> [options]

Learn from a repository's review history: the review comments that people with write access
left on its last merged pull requests are distilled into learnings by a fast model in the
sandbox. Every one is stored as pending: nothing is used in a review until someone with write
access approves it, on the dashboard's "Learn from history" page or with \`@lgtmoose approve\`.

The request goes to the deployment's artifact bucket with your AWS credentials, and the
reconciler starts it on its next run. It spends model time, up to \`learnings.bootstrapMaxCostUsd\`
(5 USD by default), and counts against the spend caps.

Options:
  --repo <owner/name>  The repository (required). LGTMoose must be installed on it.
  --prs <n>            Merged PRs to read, newest first (default: ${DEFAULT_PRS}, at most ${MAX_PRS})
  --max-cost <usd>     A lower cost cap for this one (the deployment's applies if lower)
  --resume             Read the PRs older than the ones the last bootstrap read
  -h, --help
`;

export interface LearningsDeps {
  loadConfig(): Promise<DeployConfig | undefined>;
  stacks(region: string): StackLookup;
  putObject(region: string, bucket: string, key: string, body: string): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const fail = (message: string, exitCode = 1): CommandResult => ({
  exitCode,
  stdout: "",
  stderr: `${message}\n`,
});

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function runLearnings(
  argv: readonly string[],
  getDeps: () => Promise<LearningsDeps>,
): Promise<CommandResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        prs: { type: "string" },
        "max-cost": { type: "string" },
        resume: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(`${errorMessage(error)}\n\n${LEARNINGS_HELP}`);
  }
  const { values, positionals } = parsed;
  const [sub, ...rest] = positionals;
  if (values.help === true || sub === undefined) {
    return { exitCode: 0, stdout: LEARNINGS_HELP, stderr: "" };
  }
  if (sub !== "bootstrap" || rest.length > 0) {
    return fail(`Unknown learnings command: ${positionals.join(" ")}\n\n${LEARNINGS_HELP}`);
  }
  const repo = values.repo?.trim() ?? "";
  if (!REPO.test(repo)) return fail(`bootstrap needs --repo <owner/name>.\n\n${LEARNINGS_HELP}`);
  const prs = values.prs === undefined ? DEFAULT_PRS : Number(values.prs);
  if (!Number.isSafeInteger(prs) || prs < 1 || prs > MAX_PRS) {
    return fail(`--prs is a whole number from 1 to ${MAX_PRS}.`);
  }
  const maxCost = values["max-cost"] === undefined ? undefined : Number(values["max-cost"]);
  if (maxCost !== undefined && !(Number.isFinite(maxCost) && maxCost >= 0 && maxCost <= 1000)) {
    return fail("--max-cost is a number of dollars from 0 to 1000.");
  }
  try {
    const deps = await getDeps();
    const config = await deps.loadConfig();
    if (config === undefined) return fail(`No config found. Run ${CLI} setup first.`);
    const data = await deps.stacks(config.region).describe(STACK_NAMES.data);
    const bucket = data?.outputs[STACK_OUTPUTS.data.artifactBucketName];
    if (bucket === undefined) {
      return fail(
        `No deployed ${STACK_NAMES.data} stack in ${config.region}. Run ${CLI} deploy first.`,
      );
    }
    const request = {
      version: 1,
      repo,
      maxPrs: prs,
      ...(maxCost === undefined ? {} : { maxCostUsd: maxCost }),
      ...(values.resume === true ? { resume: true } : {}),
    };
    await deps.putObject(
      config.region,
      bucket,
      `${BOOTSTRAP_REQUEST_PREFIX}${randomUUID()}.json`,
      JSON.stringify(request),
    );
    const cap = Math.min(maxCost ?? Infinity, config.learnings.bootstrapMaxCostUsd);
    return {
      exitCode: 0,
      stdout: [
        `Asked to learn from ${repo}'s last ${prs} merged pull requests${values.resume === true ? ", older than the last bootstrap read" : ""}, for at most $${cap.toFixed(2)} of model time.`,
        `The reconciler starts it on its next run (every ${config.reconcileIntervalMinutes} minutes). Follow it, and approve what it proposes, on the dashboard's "Learn from history" page.`,
        "",
      ].join("\n"),
      stderr: "",
    };
  } catch (error) {
    return fail(errorMessage(error));
  }
}
