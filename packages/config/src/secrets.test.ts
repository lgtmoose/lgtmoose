import { describe, expect, it } from "vitest";
import { PROVIDER_SECRET_PREFIX, SECRET_NAMES, providerNeedsSecret } from "./secrets.js";

describe("secrets", () => {
  it("names provider secrets by provider id", () => {
    expect(SECRET_NAMES.provider("claude")).toBe("lgtmoose/provider/claude");
    expect(SECRET_NAMES.provider("claude").startsWith(PROVIDER_SECRET_PREFIX)).toBe(true);
  });

  it("keeps the webhook secret apart from the App's private key", () => {
    expect(SECRET_NAMES.githubWebhook).not.toBe(SECRET_NAMES.githubApp);
  });

  it("needs no stored secret for Bedrock only", () => {
    expect(providerNeedsSecret({ auth: "bedrock" })).toBe(false);
    expect(providerNeedsSecret({ auth: "oauth-token" })).toBe(true);
    expect(providerNeedsSecret({ auth: "api-key" })).toBe(true);
  });
});
