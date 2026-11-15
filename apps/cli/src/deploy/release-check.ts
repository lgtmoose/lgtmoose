import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../paths.js";
import { errorMessage } from "../errors.js";

/** Where LGTMoose's releases are published. */
export const RELEASES_API = "https://api.github.com/repos/lgtmoose/lgtmoose/releases/latest";

/** Skips the check (CI, air-gapped machines, or anyone who'd rather not). */
export const NO_RELEASE_CHECK_ENV = "LGTMOOSE_NO_RELEASE_CHECK";

/** This checkout's version: the `lgtmoose` package's, which every release is tagged with. */
export function localVersion(root: string = REPO_ROOT): string {
  const text = readFileSync(join(root, "apps/cli/package.json"), "utf8");
  const version = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("apps/cli/package.json has no version");
  return version;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Compares two versions (`1.2.3`, `v1.2.3`, `1.2.3-rc.1`): negative when `a` is older. A
 * prerelease is older than its release; two prereleases compare as text. Undefined when either
 * isn't a version.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (x === null || y === null) return undefined;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return diff;
  }
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined) return 1;
  if (y[4] === undefined) return -1;
  return x[4] < y[4] ? -1 : 1;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The latest release's tag, from GitHub's public API, without credentials. Undefined when there
 * is no release yet. Throws on a network error or an unexpected reply; the caller only warns.
 */
export async function latestRelease(
  fetchFn: Fetch = (url, init) => fetch(url, init),
): Promise<string | undefined> {
  const response = await fetchFn(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "lgtmoose-cli" },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const tag = ((await response.json()) as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string") throw new Error("the release has no tag");
  return tag;
}

/**
 * What to tell the person about releases before a deploy: a warning when this checkout is older
 * than the latest release, a note when the check couldn't run, nothing otherwise. It never stops
 * a deploy: an operator may deploy an older checkout on purpose, or have no network.
 */
export async function releaseNotice(options: {
  local: string;
  latest: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  let latest: string | undefined;
  try {
    latest = await options.latest();
  } catch (error) {
    return `Couldn't check for a newer LGTMoose release (${errorMessage(error)}); deploying this checkout anyway.\n`;
  }
  if (latest === undefined) return undefined;
  const order = compareVersions(options.local, latest);
  if (order === undefined || order >= 0) return undefined;
  return (
    `Warning: this checkout is LGTMoose ${options.local}, and ${latest} is out ` +
    `(https://github.com/lgtmoose/lgtmoose/releases/tag/${latest}). To upgrade first: ` +
    `git fetch --tags && git checkout ${latest}. Deploying this checkout anyway.\n`
  );
}
