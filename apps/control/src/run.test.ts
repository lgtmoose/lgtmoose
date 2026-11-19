import { describe, expect, it } from "vitest";
import { causeOf } from "./run.js";

describe("causeOf", () => {
  it("keeps the underlying error in front of a long query", () => {
    const cause = "unable to get local issuer certificate";
    const error = new Error(`Failed query: ${"x".repeat(1500)}`);
    error.cause = new Error(cause);
    const text = causeOf(error);
    expect(text.startsWith(cause)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain("Failed query");
  });

  it("leaves out a nested message that the outer message already has", () => {
    const error = new Error("unable to get local issuer certificate");
    error.cause = new Error("unable to get local issuer certificate");
    expect(causeOf(error)).toBe("unable to get local issuer certificate");
  });

  it("redacts a credential in the underlying error and keeps the rest", () => {
    const error = new Error("Failed query: select 1");
    error.cause = new Error(
      "connection failed, password=hunter2secret, host refused the certificate",
    );
    const text = causeOf(error);
    expect(text).not.toContain("hunter2secret");
    expect(text).toContain("[redacted secret value]");
    expect(text).toContain("host refused the certificate");
  });

  it("redacts a private key in the underlying error", () => {
    const error = new Error("Failed query: select 1");
    error.cause = new Error(
      "-----BEGIN PRIVATE KEY-----\nsecretkeymaterial\n-----END PRIVATE KEY-----",
    );
    const text = causeOf(error);
    expect(text).not.toContain("secretkeymaterial");
    expect(text).toContain("[redacted private key]");
  });
});
