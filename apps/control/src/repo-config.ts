import { parseRepoConfigYaml, type RepoConfig } from "@lgtmoose/config";
import { GitHubError, repoPath, type GitHubClient } from "@lgtmoose/poster";
import { z } from "zod";

const contentReply = z.object({ content: z.string(), encoding: z.string() });

/**
 * The repo config (`.lgtmoose.yaml`) at a commit, read with the contents API: the defaults when
 * there's none, as the review uses. Read at the PR's base, never its head, so a PR can't change
 * how it's handled. Throws when the config can't be read or isn't valid.
 */
export async function repoConfigAt(
  client: Pick<GitHubClient, "request">,
  repo: string,
  sha: string,
): Promise<RepoConfig> {
  const [owner = "", name = ""] = repo.split("/");
  let text: string | undefined;
  try {
    const reply = contentReply.parse(
      await client.request(
        "GET",
        `${repoPath({ owner, repo: name })}/contents/.lgtmoose.yaml?ref=${encodeURIComponent(sha)}`,
      ),
    );
    if (reply.encoding !== "base64") throw new Error("The repo config isn't base64-encoded.");
    text = Buffer.from(reply.content, "base64").toString("utf8");
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
  }
  return parseRepoConfigYaml(text);
}
