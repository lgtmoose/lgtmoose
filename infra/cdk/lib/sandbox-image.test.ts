import { STACK_NAMES, parseDeployConfig, type DeployConfig } from "@lgtmoose/config";
import { CURSOR_AGENT_SHA256, CURSOR_AGENT_VERSION } from "@lgtmoose/harness";
import { AssetManifestArtifact } from "aws-cdk-lib/cx-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { ALLOW_UNVERIFIED_CURSOR_ENV, IMAGE_ARCH, sandboxBuildArgs } from "./sandbox-image.js";
import { appWithoutBundling } from "./test-utils.js";

const CLAUDE = { id: "claude", harness: "claude-code", auth: "oauth-token" } as const;
const CURSOR = { id: "cursor", harness: "cursor-agent", auth: "api-key" } as const;

function config(providers: unknown[]): DeployConfig {
  return parseDeployConfig({ allowedOrgs: ["lgtmoose"], providers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@lgtmoose/harness");
  vi.resetModules();
});

describe("sandboxBuildArgs", () => {
  it("installs no Cursor CLI when no provider uses cursor-agent", () => {
    expect(sandboxBuildArgs(config([CLAUDE]).providers, false)).toEqual({});
  });

  it("refuses a cursor-agent provider while the checksum is missing, saying what to do", () => {
    expect(CURSOR_AGENT_SHA256[IMAGE_ARCH]).toBe("");
    expect(() => sandboxBuildArgs(config([CLAUDE, CURSOR]).providers, false)).toThrow(
      new RegExp(`cursor.*CURSOR_AGENT_SHA256\\.${IMAGE_ARCH}.*${ALLOW_UNVERIFIED_CURSOR_ENV}=1`),
    );
  });

  it("installs it unverified only when the deploy allows that", () => {
    expect(sandboxBuildArgs(config([CURSOR]).providers, true)).toEqual({
      INSTALL_CURSOR_AGENT: "1",
      CURSOR_AGENT_VERSION,
      ALLOW_UNVERIFIED_CURSOR: "1",
    });
  });

  it("passes the image architecture's checksum once it's recorded", async () => {
    vi.doMock("@lgtmoose/harness", () => ({
      CURSOR_AGENT_VERSION,
      CURSOR_AGENT_SHA256: { amd64: "a".repeat(64), arm64: "b".repeat(64) },
    }));
    const { sandboxBuildArgs: withSha } = await import("./sandbox-image.js");
    expect(withSha(config([CURSOR]).providers, false)).toEqual({
      INSTALL_CURSOR_AGENT: "1",
      CURSOR_AGENT_VERSION,
      CURSOR_AGENT_SHA256: "b".repeat(64),
    });
  });
});

/** The sandbox image's Docker build args, from the Workflow stack's asset manifest. */
function sandboxImageBuildArgs(app: ReturnType<typeof appWithoutBundling>) {
  const stack = app.synth().getStackByName(STACK_NAMES.workflow);
  const images = stack.dependencies
    .filter((dep): dep is AssetManifestArtifact => dep instanceof AssetManifestArtifact)
    .flatMap((manifest) => Object.values(manifest.contents.dockerImages ?? {}))
    .filter((image) => image.source.dockerFile === "infra/sandbox/Dockerfile");
  expect(images).toHaveLength(1);
  return images[0]?.source.dockerBuildArgs ?? {};
}

describe("the Workflow stack's sandbox image", () => {
  it("builds without Cursor for a deploy with no cursor-agent provider", () => {
    const app = appWithoutBundling();
    buildApp(config([CLAUDE]), app);
    expect(sandboxImageBuildArgs(app)).not.toHaveProperty("INSTALL_CURSOR_AGENT");
  }, 120_000);

  it("fails synth for a cursor-agent provider without the checksum or the opt-out", () => {
    expect(() => buildApp(config([CLAUDE, CURSOR]), appWithoutBundling())).toThrow(
      ALLOW_UNVERIFIED_CURSOR_ENV,
    );
  }, 120_000);

  it(`installs Cursor unverified with ${ALLOW_UNVERIFIED_CURSOR_ENV}=1`, () => {
    vi.stubEnv(ALLOW_UNVERIFIED_CURSOR_ENV, "1");
    const app = appWithoutBundling();
    buildApp(config([CLAUDE, CURSOR]), app);
    expect(sandboxImageBuildArgs(app)).toMatchObject({
      INSTALL_CURSOR_AGENT: "1",
      CURSOR_AGENT_VERSION,
      ALLOW_UNVERIFIED_CURSOR: "1",
    });
  }, 120_000);
});
