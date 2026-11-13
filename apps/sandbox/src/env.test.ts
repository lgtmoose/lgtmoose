import { describe, expect, it } from "vitest";
import { readSandboxEnv } from "./env.js";

describe("readSandboxEnv", () => {
  it("reads every setting", () => {
    expect(
      readSandboxEnv({
        ARTIFACT_BUCKET: "bucket",
        ARTIFACT_PREFIX: "sandbox/",
        LGTMOOSE_PROVIDER: "claude",
        HTTPS_PROXY: "http://proxy.lgtmoose.internal:3128",
      }),
    ).toEqual({
      artifactBucket: "bucket",
      prefix: "sandbox/",
      providerId: "claude",
      httpsProxy: "http://proxy.lgtmoose.internal:3128",
    });
  });

  it("names the missing ones", () => {
    expect(readSandboxEnv({ ARTIFACT_BUCKET: "b" })).toEqual({
      missing: ["ARTIFACT_PREFIX", "LGTMOOSE_PROVIDER", "HTTPS_PROXY"],
    });
  });
});
