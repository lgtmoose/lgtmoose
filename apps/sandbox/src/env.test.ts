import { describe, expect, it } from "vitest";
import { readSandboxEnv } from "./env.js";

describe("readSandboxEnv", () => {
  it("reads every setting", () => {
    expect(
      readSandboxEnv({
        LGTMOOSE_PROVIDER: "claude",
        HTTPS_PROXY: "http://egress-proxy.lgtmoose.internal:3128",
        LGTMOOSE_HARNESS: "claude-code",
        LGTMOOSE_AUTH: "oauth-token",
        LGTMOOSE_BATCH_URLS: "https://bucket.s3.amazonaws.com/urls.json?sig",
      }),
    ).toEqual({
      providerId: "claude",
      httpsProxy: "http://egress-proxy.lgtmoose.internal:3128",
      harness: "claude-code",
      auth: "oauth-token",
      batchUrls: "https://bucket.s3.amazonaws.com/urls.json?sig",
    });
  });

  it("names the missing ones", () => {
    expect(readSandboxEnv({ LGTMOOSE_PROVIDER: "claude", LGTMOOSE_AUTH: " " })).toEqual({
      missing: ["HTTPS_PROXY", "LGTMOOSE_HARNESS", "LGTMOOSE_AUTH", "LGTMOOSE_BATCH_URLS"],
    });
  });
});
