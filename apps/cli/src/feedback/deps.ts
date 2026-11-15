import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { FEEDBACK_REPORT_KEY } from "@lgtmoose/config";
import { z } from "zod";
import { awsError, errorName } from "../aws-errors.js";
import { createStackLookup } from "../deploy/aws-cloudformation.js";
import { GitHubRequestError, githubRequest } from "../github-request.js";
import { configPath, loadDeployConfig, nodeFiles } from "../paths.js";
import { resolveGitHubToken } from "../review/token.js";
import type { FeedbackDeps } from "./feedback.js";

const GITHUB_API = "https://api.github.com";

const contentReply = z.object({ content: z.string(), encoding: z.literal("base64") });

/** The real thing: the deploy config, CloudFormation, S3 and GitHub, and the disk. */
export function defaultFeedbackDeps(): FeedbackDeps {
  return {
    loadConfig: () => loadDeployConfig(nodeFiles, configPath()),
    stacks: createStackLookup,
    async readObject(region, bucket, key) {
      try {
        const object = await new S3Client({ region }).send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        return (await object.Body?.transformToString("utf8")) ?? "";
      } catch (error) {
        if (errorName(error) === "NoSuchKey") return undefined;
        throw awsError("S3", region, `${bucket}/${key}`, error);
      }
    },
    githubToken: () => resolveGitHubToken(process.env),
    async fileAt(token, repo, path, ref) {
      const [owner = "", name = ""] = repo.split("/");
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      try {
        const reply = contentReply.parse(
          await githubRequest(
            fetch,
            GITHUB_API,
            "GET",
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
            { jwt: token },
          ),
        );
        return Buffer.from(reply.content, "base64").toString("utf8");
      } catch (error) {
        if (error instanceof GitHubRequestError && error.status === 404) return undefined;
        throw error;
      }
    },
    async writeFile(path, text) {
      await mkdir(dirname(path), { recursive: true });
      // Never over an existing file: an earlier export, or something else, stays as it is.
      await writeFile(path, text, { encoding: "utf8", flag: "wx" });
    },
    reportKey: FEEDBACK_REPORT_KEY,
  };
}
