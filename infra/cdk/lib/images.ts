import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";
import { RELEASE_IMAGES, type DeployConfig } from "@lgtmoose/config";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A task image, as `images.digests` names it. */
export type ImageKey = keyof typeof RELEASE_IMAGES;

/** How to build an image from this checkout: a context directory and, optionally, a Dockerfile. */
export interface LocalBuild {
  directory: string;
  file?: string;
  buildArgs?: Record<string, string>;
}

/**
 * The reference of a release's image, pinned by digest: `<registry>/<name>@sha256:…`. A tag can
 * be moved after the fact; a digest names exactly the bytes that were verified.
 */
export function releaseImageRef(
  images: Extract<DeployConfig["images"], { source: "release" }>,
  key: ImageKey,
): string {
  return `${images.registry}/${RELEASE_IMAGES[key]}@${images.digests[key]}`;
}

/**
 * A one-line build context for a release's image: `FROM <ref>`. CDK builds it like any image
 * asset, which only pulls the release's image, and pushes it to the deployment's own asset
 * repository in ECR. So tasks pull from ECR, as they do for built images: the sandbox subnet
 * keeps its no-internet rule (its only routes are the VPC endpoints) and nothing pulls from the
 * registry at run time. The folder is named after the digest, so the asset hash is stable.
 */
export function releaseContext(ref: string, root: string = tmpdir()): string {
  const digest = ref.slice(ref.indexOf("@sha256:") + "@sha256:".length);
  const directory = join(root, "lgtmoose-release-images", digest);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "Dockerfile"), `FROM ${ref}\n`);
  return directory;
}

/**
 * A task image, for arm64: built from this checkout with `build`, or a release's image with
 * `images: { source: "release" }`. Build args (the sandbox's Cursor CLI) only apply to local
 * builds; a release's sandbox image is built without the Cursor CLI, and the config refuses
 * cursor-agent with it.
 */
export function taskImage(
  images: DeployConfig["images"],
  key: ImageKey,
  local: LocalBuild,
): ContainerImage {
  if (images.source === "release") {
    return ContainerImage.fromAsset(releaseContext(releaseImageRef(images, key)), {
      platform: Platform.LINUX_ARM64,
    });
  }
  return ContainerImage.fromAsset(local.directory, {
    ...(local.file === undefined ? {} : { file: local.file }),
    platform: Platform.LINUX_ARM64,
    buildArgs: local.buildArgs ?? {},
  });
}
