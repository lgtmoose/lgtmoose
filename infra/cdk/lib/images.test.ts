import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeployConfig, type DeployConfig } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { releaseContext, releaseImageRef } from "./images.js";
import { appWithoutBundling } from "./test-utils.js";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const RELEASE = {
  source: "release" as const,
  version: "0.1.0",
  digests: { control: digest("a"), sandbox: digest("b"), egressProxy: digest("c") },
};

function config(images?: unknown): DeployConfig {
  return parseDeployConfig({
    allowedOrgs: ["lgtmoose"],
    providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
    ...(images === undefined ? {} : { images }),
  });
}

/** The Dockerfile of each container image asset the app stages, from its asset manifests. */
function imageDockerfiles(images?: unknown): string[] {
  const app = appWithoutBundling();
  buildApp(config(images), app);
  const { directory } = app.synth();
  const seen = new Set<string>();
  return readdirSync(directory)
    .filter((name) => name.endsWith(".assets.json"))
    .flatMap((name) => {
      const manifest = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
        dockerImages?: Record<string, { source: { directory: string; dockerFile?: string } }>;
      };
      return Object.entries(manifest.dockerImages ?? {}).flatMap(([hash, image]) => {
        if (seen.has(hash)) return [];
        seen.add(hash);
        const file = join(
          directory,
          image.source.directory,
          image.source.dockerFile ?? "Dockerfile",
        );
        return [readFileSync(file, "utf8")];
      });
    });
}

describe("task images", () => {
  it("pins a release's image by digest, never by tag", () => {
    const images = config(RELEASE).images;
    if (images.source !== "release") throw new Error("expected release images");
    expect(releaseImageRef(images, "control")).toBe(
      `ghcr.io/lgtmoose/lgtmoose-control@${digest("a")}`,
    );
    expect(releaseImageRef(images, "sandbox")).toBe(
      `ghcr.io/lgtmoose/lgtmoose-sandbox@${digest("b")}`,
    );
    expect(releaseImageRef(images, "egressProxy")).toBe(
      `ghcr.io/lgtmoose/lgtmoose-egress-proxy@${digest("c")}`,
    );
  });

  it("writes a one-line build context per digest", () => {
    const root = mkdtempSync(join(tmpdir(), "lgtmoose-images-test-"));
    const ref = `ghcr.io/lgtmoose/lgtmoose-control@${digest("d")}`;
    const directory = releaseContext(ref, root);
    expect(directory).toBe(join(root, "lgtmoose-release-images", "d".repeat(64)));
    expect(readFileSync(join(directory, "Dockerfile"), "utf8")).toBe(`FROM ${ref}\n`);
  });

  it("builds every image from this checkout by default", () => {
    const dockerfiles = imageDockerfiles();
    expect(dockerfiles).toHaveLength(3);
    for (const text of dockerfiles) expect(text).not.toMatch(/^FROM ghcr\.io\/lgtmoose\//m);
  });

  it("with a release, stages each image as its digest-pinned release image, for the deployment's ECR", () => {
    const dockerfiles = imageDockerfiles(RELEASE);
    expect(dockerfiles.sort()).toEqual(
      [
        `FROM ghcr.io/lgtmoose/lgtmoose-control@${digest("a")}\n`,
        `FROM ghcr.io/lgtmoose/lgtmoose-egress-proxy@${digest("c")}\n`,
        `FROM ghcr.io/lgtmoose/lgtmoose-sandbox@${digest("b")}\n`,
      ].sort(),
    );
  });
});
