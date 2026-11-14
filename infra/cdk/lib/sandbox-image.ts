import { CURSOR_AGENT_SHA256, CURSOR_AGENT_VERSION } from "@lgtmoose/harness";
import type { DeployConfig } from "@lgtmoose/config";

/**
 * The architecture every task image is built for (`Platform.LINUX_ARM64` in the Workflow stack),
 * as a key of `CURSOR_AGENT_SHA256`.
 */
export const IMAGE_ARCH = "arm64" as const;

/** Env var that lets a deploy build the sandbox image with an unverified Cursor CLI. */
export const ALLOW_UNVERIFIED_CURSOR_ENV = "LGTMOOSE_ALLOW_UNVERIFIED_CURSOR";

/**
 * Build args for infra/sandbox/Dockerfile. The Cursor CLI is installed only when a provider uses
 * cursor-agent, at the pinned version and with that architecture's checksum from
 * @lgtmoose/harness. Without a checksum this throws, failing synth with what to do, unless the
 * deploy explicitly allows an unverified CLI (`allowUnverifiedCursor`).
 */
export function sandboxBuildArgs(
  providers: DeployConfig["providers"],
  allowUnverifiedCursor: boolean,
): Record<string, string> {
  const cursor = providers.filter((provider) => provider.harness === "cursor-agent");
  if (cursor.length === 0) return {};
  const sha = CURSOR_AGENT_SHA256[IMAGE_ARCH];
  if (sha === "" && !allowUnverifiedCursor) {
    const ids = cursor.map((provider) => provider.id).join(", ");
    throw new Error(
      `The cursor-agent provider ${ids} needs the Cursor CLI in the sandbox image, but ` +
        `CURSOR_AGENT_SHA256.${IMAGE_ARCH} in packages/harness/src/version.ts is empty, so the ` +
        `build can't verify the download. Record the checksum of Cursor CLI ` +
        `${CURSOR_AGENT_VERSION} for linux/${IMAGE_ARCH} there, or set ` +
        `${ALLOW_UNVERIFIED_CURSOR_ENV}=1 to install it unverified.`,
    );
  }
  return {
    INSTALL_CURSOR_AGENT: "1",
    CURSOR_AGENT_VERSION,
    ...(sha === "" ? { ALLOW_UNVERIFIED_CURSOR: "1" } : { CURSOR_AGENT_SHA256: sha }),
  };
}
