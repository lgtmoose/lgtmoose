import { describe, expect, it } from "vitest";
import { SECRET_NAMES, providerNeedsSecret } from "./secrets.js";

describe("secrets", () => {
  it("names provider secrets by provider id", () => {
    expect(SECRET_NAMES.provider("claude")).toBe("lgtmoose/provider/claude");
  });

  it("needs no stored secret for Bedrock only", () => {
    expect(providerNeedsSecret({ auth: "bedrock" })).toBe(false);
    expect(providerNeedsSecret({ auth: "oauth-token" })).toBe(true);
    expect(providerNeedsSecret({ auth: "api-key" })).toBe(true);
  });
});
