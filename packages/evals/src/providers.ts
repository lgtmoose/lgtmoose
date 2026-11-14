import {
  AgentSdkHarness,
  ClaudeCodeHarness,
  CodexHarness,
  CursorHarness,
  claudeAuthEnv,
  codexAuth,
  cursorAuth,
  type Harness,
  type TranscriptStore,
} from "@lgtmoose/harness";

type Env = Readonly<Record<string, string | undefined>>;

/** What a harness for one provider is built from. */
export interface HarnessSetup {
  transcripts: TranscriptStore;
  env: Env;
  /** The provider's binary, when it isn't the default on PATH. */
  binaryPath?: string;
}

/** A provider the evals can run: a harness, how to tell it has a credential, its default model. */
export interface EvalProvider {
  id: string;
  /** What it runs, for the help text and the report. */
  description: string;
  /** The model when `--model` names none: empty means the harness's own default. */
  defaultModel: string;
  /** Why it can't run in this environment (no credential), or undefined when it can. */
  unavailable(env: Env): string | undefined;
  create(setup: HarnessSetup): Harness;
}

/** The harness's own message when its credential check throws, else undefined. */
function credentialProblem(check: () => unknown): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The providers `--providers` and `--roles` take, by id. Credentials come from the environment,
 * as for `lgtmoose review --dry-run`; no value is ever read into the report.
 */
export const EVAL_PROVIDERS: Readonly<Record<string, EvalProvider>> = {
  claude: {
    id: "claude",
    description: "Claude Code (`claude -p`)",
    defaultModel: "sonnet",
    unavailable: (env) => credentialProblem(() => claudeAuthEnv(env)),
    create: (setup) =>
      new ClaudeCodeHarness({
        transcripts: setup.transcripts,
        env: setup.env,
        ...(setup.binaryPath === undefined ? {} : { binaryPath: setup.binaryPath }),
      }),
  },
  "agent-sdk": {
    id: "agent-sdk",
    description: "the Claude Agent SDK",
    defaultModel: "sonnet",
    unavailable: (env) => {
      const problem = credentialProblem(() => claudeAuthEnv(env));
      if (problem !== undefined) return problem;
      // Anthropic's terms don't allow a claude.ai sign-in for products built on the Agent SDK.
      return claudeAuthEnv(env).method === "oauth_token"
        ? "The Agent SDK needs ANTHROPIC_API_KEY, Bedrock or Vertex, not CLAUDE_CODE_OAUTH_TOKEN."
        : undefined;
    },
    create: (setup) =>
      new AgentSdkHarness({
        transcripts: setup.transcripts,
        env: setup.env,
        ...(setup.binaryPath === undefined ? {} : { binaryPath: setup.binaryPath }),
      }),
  },
  chatgpt: {
    id: "chatgpt",
    description: "the Codex CLI (`codex exec`)",
    defaultModel: "",
    unavailable: (env) => credentialProblem(() => codexAuth(env)),
    create: (setup) =>
      new CodexHarness({
        transcripts: setup.transcripts,
        env: setup.env,
        ...(setup.binaryPath === undefined ? {} : { binaryPath: setup.binaryPath }),
      }),
  },
  cursor: {
    id: "cursor",
    description: "the Cursor CLI (`agent`)",
    defaultModel: "",
    unavailable: (env) => credentialProblem(() => cursorAuth(env)),
    create: (setup) =>
      new CursorHarness({
        transcripts: setup.transcripts,
        env: setup.env,
        ...(setup.binaryPath === undefined ? {} : { binaryPath: setup.binaryPath }),
      }),
  },
};
