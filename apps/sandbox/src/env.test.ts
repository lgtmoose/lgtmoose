import { describe, expect, it } from "vitest";
import { readSandboxEnv } from "./env.js";

describe("readSandboxEnv", () => {
  it("reads every setting", () => {
    expect(
      readSandboxEnv({
        LGTMOOSE_PROVIDER: "claude",
        HTTPS_PROXY: "http://egress-proxy.lgtmoose.internal:3128",
      }),
    ).toEqual({
      providerId: "claude",
      httpsProxy: "http://egress-proxy.lgtmoose.internal:3128",
    });
  });

  it("names the missing ones", () => {
    expect(readSandboxEnv({ LGTMOOSE_PROVIDER: "claude" })).toEqual({
      missing: ["HTTPS_PROXY"],
    });
  });
});
