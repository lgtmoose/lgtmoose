import { readFile } from "node:fs/promises";
import { configPath, nodeFiles } from "../paths.js";
import type { AuthDeps, AuthPrompter } from "./auth.js";
import { createBedrockAccess } from "./bedrock.js";
import { createCredentialStore } from "./credential-store.js";
import { spawnInteractive, trapProcessSignals } from "./process.js";

async function inquirerAuthPrompter(): Promise<AuthPrompter> {
  const { confirm, password } = await import("@inquirer/prompts");
  return {
    // No `mask`: inquirer then echoes nothing at all, not even the length.
    password: (options) => password(options),
    confirm: (options) => confirm(options),
  };
}

/** The real thing: inquirer, AWS Secrets Manager and Bedrock, and the vendor CLIs. */
export async function defaultAuthDeps(): Promise<AuthDeps> {
  return {
    configPath: configPath(),
    files: nodeFiles,
    prompter: await inquirerAuthPrompter(),
    credentials: createCredentialStore,
    bedrock: createBedrockAccess,
    run: spawnInteractive,
    trapSignals: trapProcessSignals,
    out: (text) => process.stdout.write(text),
    readKeyFile: (path) => readFile(path, "utf8"),
  };
}
