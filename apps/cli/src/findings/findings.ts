import { parseArgs } from "node:util";
import { STACK_NAMES, STACK_OUTPUTS, type DeployConfig } from "@lgtmoose/config";
import {
  agentFindingSchema,
  agentFindingsMarkdown,
  plainLine,
  type AgentFinding,
} from "@lgtmoose/core";
import { z } from "zod";
import type { StackLookup } from "../deploy/aws-cloudformation.js";
import { errorMessage } from "../errors.js";
import { CLI } from "../paths.js";

export const FINDINGS_HELP = `Usage:
  ${CLI} findings <owner/repo>#<number> [--format md|json|text]
  ${CLI} findings ack <id> fixed
  ${CLI} findings ack <id> declined --reason "<why>"

A pull request's open findings, and answers to them, through the deployment's dashboard API.
This works in shadow mode too, where findings aren't on GitHub. Nothing is posted to GitHub.

  <owner/repo>#<n>  List the PR's open findings. --format md is written for a coding agent:
                    paste it into its prompt. Needs read access to the repository.
  ack <id> fixed    Say a finding is fixed. The next review checks it again first, and closes it
                    only if the problem is gone.
  ack <id> declined Say it isn't a problem, with --reason. It closes the finding, and counts as a
                    decline on its thread would. The PR's author can't decline a blocking or
                    protected finding. Needs write access to the repository.

Your GitHub token comes from GITHUB_TOKEN, GH_TOKEN or \`gh auth token\`. GitHub says who you are
and what you can do on the repository; the token isn't kept. Answering needs a token that can
write: \`gh auth token\`, or a classic token with the repo scope. A fine-grained token can list only.

Options:
  --format <f>   md (default), json or text
  --reason <r>   declined: why it isn't a problem (required)
  --url <url>    The dashboard's URL. Default: LGTMOOSE_DASHBOARD_URL, or the deployed
                 ${STACK_NAMES.dashboard} stack's output (docker compose: http://localhost:<port>)
  -h, --help
`;

/** The header the dashboard API reads the token from (`dashboard-findings.ts`). */
export const TOKEN_HEADER = "x-lgtmoose-github-token";

export interface FindingsDeps {
  loadConfig(): Promise<DeployConfig | undefined>;
  stacks(region: string): StackLookup;
  env: Readonly<Record<string, string | undefined>>;
  /** A GitHub token, or undefined when there's none. */
  githubToken(): Promise<string | undefined>;
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class UsageError extends Error {}

const fail = (message: string, exitCode = 1): CommandResult => ({
  exitCode,
  stdout: "",
  stderr: `${message}\n`,
});

const PR_TARGET = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const FINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An https URL, or http on this machine (docker compose), with no path. */
function dashboardOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

async function dashboardUrl(deps: FindingsDeps, given: string | undefined): Promise<string> {
  const explicit = given ?? deps.env.LGTMOOSE_DASHBOARD_URL;
  if (explicit !== undefined && explicit.trim() !== "") {
    const origin = dashboardOrigin(explicit.trim());
    if (origin === undefined) {
      throw new UsageError(
        "The dashboard URL must be https://, or http://localhost for docker compose.",
      );
    }
    return origin;
  }
  const config = await deps.loadConfig();
  if (config === undefined) {
    throw new UsageError(
      `No config found. Run ${CLI} setup first, or give the dashboard's URL with --url.`,
    );
  }
  const stack = await deps.stacks(config.region).describe(STACK_NAMES.dashboard);
  const url = stack?.outputs[STACK_OUTPUTS.dashboard.dashboardUrl];
  const origin = url === undefined ? undefined : dashboardOrigin(url);
  if (origin === undefined) {
    throw new UsageError(
      `No deployed ${STACK_NAMES.dashboard} stack in ${config.region}. Deploy with the dashboard on, or give its URL with --url.`,
    );
  }
  return origin;
}

const errorReply = z.object({ error: z.string() });

/** Calls the dashboard API with the person's token; a refusal becomes a readable message. */
async function call(
  deps: FindingsDeps,
  base: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  const token = await deps.githubToken();
  if (token === undefined) {
    throw new UsageError("No GitHub token: set GITHUB_TOKEN or GH_TOKEN, or sign in with `gh`.");
  }
  const response = await deps.fetch(`${base}${path}`, {
    method: init.method,
    headers: {
      accept: "application/json",
      [TOKEN_HEADER]: token,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    // Never followed: a redirect would carry the token header to another origin.
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const reason = errorReply.safeParse(body);
    const why = reason.success ? reason.data.error : `HTTP ${response.status}`;
    if (response.status === 401) {
      throw new UsageError(`GitHub didn't accept your token (${why}).`);
    }
    if (response.status === 429) {
      throw new UsageError(`Too many failed sign-ins from here: wait a few minutes (${why}).`);
    }
    if (response.status === 503) {
      throw new UsageError(
        `GitHub couldn't be asked about your access just now: ${why}. Try again.`,
      );
    }
    throw new UsageError(`The dashboard refused: ${why}.`);
  }
  return body;
}

/** The findings as a short plain list, for a person at a terminal. */
function formatText(repo: string, number: number, findings: readonly AgentFinding[]): string {
  if (findings.length === 0) return `No open findings on ${repo}#${number}.\n`;
  const lines = findings.map((finding) => {
    const where =
      finding.path === undefined
        ? ""
        : ` ${plainLine(finding.path)}${finding.line === undefined ? "" : `:${finding.line}`}`;
    const claimed = finding.fixClaimedAt === undefined ? "" : " (fixed: waiting for recheck)";
    return `${plainLine(finding.id)}  ${finding.severity}${where}  ${plainLine(finding.title)}${claimed}`;
  });
  return `${lines.join("\n")}\n`;
}

async function list(
  deps: FindingsDeps,
  target: string,
  format: "md" | "json" | "text",
  url: string | undefined,
): Promise<CommandResult> {
  const match = PR_TARGET.exec(target);
  if (match === null) throw new UsageError(`Give the pull request as owner/repo#123.`);
  const repo = (match[1] ?? "").toLowerCase();
  const number = Number(match[2]);
  const base = await dashboardUrl(deps, url);
  const query = new URLSearchParams({ repo, pr: String(number) });
  const reply = z
    .object({ findings: z.array(z.unknown()) })
    .parse(await call(deps, base, `/api/findings?${query.toString()}`, { method: "GET" }));
  // Only LGTMoose's own: other reviewers' are on GitHub, answered there.
  const findings = reply.findings.flatMap((entry) => {
    const parsed = agentFindingSchema.safeParse(entry);
    return parsed.success && (parsed.data.source ?? "self") === "self" ? [parsed.data] : [];
  });
  const formats = {
    json: () => `${JSON.stringify(findings, null, 2)}\n`,
    text: () => formatText(repo, number, findings),
    md: () => agentFindingsMarkdown({ repo, number, findings, cli: CLI }),
  };
  return { exitCode: 0, stdout: formats[format](), stderr: "" };
}

async function ack(
  deps: FindingsDeps,
  args: readonly string[],
  reason: string | undefined,
  url: string | undefined,
): Promise<CommandResult> {
  const [rawId, outcome, ...extra] = args;
  const id = rawId?.toLowerCase();
  if (id === undefined || !FINDING_ID.test(id) || extra.length > 0) {
    throw new UsageError(`Usage: ${CLI} findings ack <id> fixed|declined [--reason "<why>"]`);
  }
  if (outcome !== "fixed" && outcome !== "declined") {
    throw new UsageError("Answer with fixed or declined.");
  }
  if (outcome === "declined" && (reason === undefined || reason.trim() === "")) {
    throw new UsageError('A decline needs --reason "<why>".');
  }
  if (outcome === "fixed" && reason !== undefined) {
    throw new UsageError("--reason goes with declined only.");
  }
  const base = await dashboardUrl(deps, url);
  await call(deps, base, `/api/findings/${id}/ack`, {
    method: "POST",
    body: outcome === "fixed" ? { outcome } : { outcome, reason: reason?.trim() },
  });
  return {
    exitCode: 0,
    stdout:
      outcome === "fixed"
        ? `Marked ${id} fixed. The next review checks it again first, and closes it if the problem is gone.\n`
        : `Declined ${id}.\n`,
    stderr: "",
  };
}

export async function runFindings(
  argv: readonly string[],
  getDeps: () => Promise<FindingsDeps>,
): Promise<CommandResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        format: { type: "string" },
        reason: { type: "string" },
        url: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(`${errorMessage(error)}\n\n${FINDINGS_HELP}`);
  }
  const { values, positionals } = parsed;
  const [first, ...rest] = positionals;
  if (values.help === true || first === undefined) {
    return { exitCode: 0, stdout: FINDINGS_HELP, stderr: "" };
  }
  try {
    if (first === "ack") {
      if (values.format !== undefined) throw new UsageError("--format goes with a listing only.");
      return await ack(await getDeps(), rest, values.reason, values.url);
    }
    if (rest.length > 0) throw new UsageError(`Unexpected: ${rest.join(" ")}`);
    if (values.reason !== undefined) throw new UsageError("--reason goes with ack only.");
    const format = values.format ?? "md";
    if (format !== "md" && format !== "json" && format !== "text") {
      throw new UsageError("--format is md, json or text.");
    }
    return await list(await getDeps(), first, format, values.url);
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message);
    return fail(errorMessage(error));
  }
}
