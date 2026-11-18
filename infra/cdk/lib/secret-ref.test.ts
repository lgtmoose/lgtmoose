import { App, Stack } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { describe, expect, it } from "vitest";
import { partialArnHidesName, secretId } from "./secret-ref.js";

describe("secretId", () => {
  const stack = () => new Stack(new App(), "Secrets");

  it("uses the name when a partial ARN would be read as a different secret", () => {
    const imported = Secret.fromSecretNameV2(
      stack(),
      "Imported",
      "lgtmoose/provider/claude-backup",
    );
    expect(partialArnHidesName(imported.secretName)).toBe(true);
    expect(imported.secretArn).toMatch(/:secret:lgtmoose\/provider\/claude-backup$/);
    expect(secretId(imported)).toBe("lgtmoose/provider/claude-backup");
  });

  it("uses the name for an imported secret whose partial ARN does resolve", () => {
    const imported = Secret.fromSecretNameV2(stack(), "Imported", "lgtmoose/github-app");
    expect(partialArnHidesName(imported.secretName)).toBe(false);
    expect(secretId(imported)).toBe("lgtmoose/github-app");
  });

  it("keeps the full ARN of a secret this stack creates", () => {
    const created = new Secret(stack(), "Created");
    expect(secretId(created)).toBe(created.secretFullArn);
    expect(secretId(created)).not.toBe(created.secretName);
  });
});
