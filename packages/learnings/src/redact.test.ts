import { describe, expect, it } from "vitest";
import { redactSensitive } from "./redact.js";

describe("redactSensitive", () => {
  it.each([
    ["a GitHub token", `use ghp_${"a".repeat(36)} to call it`, "token"],
    ["a fine-grained token", `github_pat_${"B".repeat(40)}`, "token"],
    ["an Anthropic key", `sk-ant-api03-${"x".repeat(40)}`, "token"],
    ["an OpenAI key", `sk-proj-${"y".repeat(40)}`, "token"],
    ["a Slack token", "xoxb-1234567890-abcdefghij", "token"],
    ["a Stripe key", `sk_live_${"9".repeat(24)}`, "token"],
    ["an AWS key ID", "AKIAIOSFODNN7EXAMPLE is ours", "aws key"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "jwt"],
    [
      "a private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      "private key",
    ],
    ["an email", "ask jane.doe@example.com first", "email"],
    ["a phone number", "call +31 6 1234 5678", "phone number"],
    ["a card number", "4111 1111 1111 1111 is the test card", "card number"],
  ])("replaces %s", (_name, text, kind) => {
    const out = redactSensitive(text);
    expect(out.found).toContain(kind);
    expect(out.text).toContain(`[redacted ${kind}]`);
  });

  it("keeps the key name of a secret value and replaces only the value", () => {
    expect(redactSensitive('password = "hunter22" in the fixture').text).toBe(
      'password = "[redacted secret value]" in the fixture',
    );
    expect(redactSensitive("Authorization: Bearer abc.def.ghi123").text).toBe(
      "Authorization: Bearer [redacted secret value]",
    );
  });

  it("replaces the password in a URL and keeps the rest", () => {
    expect(redactSensitive("postgres://app:s3cretpw@db.internal:5432/app").text).toBe(
      "postgres://app:[redacted credential in url]@db.internal:5432/app",
    );
  });

  it("leaves ordinary learning text alone", () => {
    const text =
      "We use zod for validation in src/api/**; line 120 of v1.2.3 is fine. Tokens are refreshed by the SDK, and 2026-11-14 is a date.";
    expect(redactSensitive(text)).toEqual({ text, found: [] });
  });

  it("doesn't take a number that fails the Luhn check for a card", () => {
    expect(redactSensitive("order 1234 5678 9012 3456").found).not.toContain("card number");
  });
});
