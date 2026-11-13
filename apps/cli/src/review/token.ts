import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Runs `gh auth token`. Rejects when gh is missing or not logged in. */
export type GhToken = () => Promise<string>;

export const ghAuthToken: GhToken = async () => {
  const { stdout } = await run("gh", ["auth", "token"], { encoding: "utf8", timeout: 10_000 });
  return stdout.trim();
};

/**
 * The GitHub token for reading the PR and cloning: `GITHUB_TOKEN`, then `GH_TOKEN`, then
 * `gh auth token`. Undefined when there's none; the caller says how to get one. The token is
 * never printed.
 */
export async function resolveGitHubToken(
  env: Readonly<Record<string, string | undefined>>,
  gh: GhToken = ghAuthToken,
): Promise<string | undefined> {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  try {
    const token = await gh();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}
