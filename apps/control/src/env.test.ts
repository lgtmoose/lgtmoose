import { describe, expect, it } from "vitest";
import { readControlEnv } from "./env.js";

describe("readControlEnv", () => {
  it("reads every setting", () => {
    expect(
      readControlEnv({
        ARTIFACT_BUCKET: "bucket",
        DATABASE_SECRET_ARN: "arn:db",
        DATABASE_NAME: "lgtmoose",
        GITHUB_APP_SECRET_ARN: "arn:gh",
      }),
    ).toEqual({
      artifactBucket: "bucket",
      databaseSecretArn: "arn:db",
      databaseName: "lgtmoose",
      githubAppSecretArn: "arn:gh",
    });
  });

  it("names the missing ones, counting blank as missing", () => {
    expect(readControlEnv({ ARTIFACT_BUCKET: " " })).toEqual({
      missing: ["ARTIFACT_BUCKET", "DATABASE_SECRET_ARN", "DATABASE_NAME", "GITHUB_APP_SECRET_ARN"],
    });
  });
});
