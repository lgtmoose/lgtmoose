import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { awsError } from "../aws-errors.js";
import { createStackLookup } from "../deploy/aws-cloudformation.js";
import { configPath, loadDeployConfig, nodeFiles } from "../paths.js";
import type { LearningsDeps } from "./learnings.js";

/** The real thing: the deploy config, CloudFormation and S3. */
export function defaultLearningsDeps(): LearningsDeps {
  return {
    loadConfig: () => loadDeployConfig(nodeFiles, configPath()),
    stacks: createStackLookup,
    async putObject(region, bucket, key, body) {
      try {
        await new S3Client({ region }).send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: "application/json",
            // Never over an earlier request: each key is new.
            IfNoneMatch: "*",
          }),
        );
      } catch (error) {
        throw awsError("S3", region, `${bucket}/${key}`, error);
      }
    },
  };
}
