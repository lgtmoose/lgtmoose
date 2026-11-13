import type { FileDiff, Hunk } from "@lgtmoose/git";

/**
 * Hosts packages normally download from. A lockfile line that resolves a package anywhere else
 * is worth a look; it may be a private registry (add it to `registries` in .lgtmoose.yaml), or
 * a dependency swapped for a lookalike.
 */
export const KNOWN_PACKAGE_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmmirror.com",
  "npm.pkg.github.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "index.rubygems.org",
  "repo.packagist.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "api.nuget.org",
  "pub.dev",
  "jsr.io",
  "deno.land",
];

/** Composer installs most packages straight from their Git host, so these are normal there. */
const COMPOSER_HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "gitlab.com",
  "bitbucket.org",
];

/** Cargo's default registry index lives on GitHub. */
const CARGO_INDEX = "github.com/rust-lang/crates.io-index";

const URL_PATTERN =
  /\b((?:git\+)?(?:https?|ssh|git)):\/\/(?:[^@/\s"']+@)?([^/:\s"']+)(?::\d+)?([^\s"'#?]*)/gi;

/**
 * Lines whose URL is where a package is downloaded from. Other URLs (npm's `funding`,
 * `homepage`, `bugs`) are metadata and aren't checked. A bare `url` key only counts inside a
 * `dist` or `source` block: composer's JSON objects, or poetry's `[package.source]` table.
 */
const DOWNLOAD_KEY = /\b(resolved|tarball|resolution|remote|registry\+|git\+|git:\/\/|ssh:\/\/)/i;
const URL_KEY = /^\s*"?url"?\s*[:=]/i;
const BLOCK_OPEN = /"?([\w-]+)"?\s*[:=]\s*[{[]\s*$/;
/** A TOML table header such as `[package.source]` or `[[package]]`; its last segment names it. */
const TOML_TABLE = /^\s*\[{1,2}\s*(?:[\w-]+\.)*([\w-]+)\s*\]{1,2}\s*$/;

/** Schemes with no TLS: what they download can be replaced in transit. */
const PLAIN_SCHEMES = new Set(["http", "git"]);

/** Git hosts where the owner/repo in the path says whose code it is. */
const GIT_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "gitlab.com",
  "bitbucket.org",
]);

const INTEGRITY = /\b(integrity|checksum|shasum|resolution|sha(?:1|256|384|512)-|h1:)/i;
/** A checksum token on a line, removed before looking for versions (go.sum holds both). */
const CHECKSUM_TOKEN =
  /\b(?:h1:|sha(?:1|256|384|512)[-:=]|10c0\/)[A-Za-z0-9+/=_.-]+|\b(?:integrity|checksum|shasum)\b["':=\s]+[A-Za-z0-9+/=_.-]+/gi;
/** A semver-like version, with any pre-release and build parts (not a following `.tgz`). */
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?/g;

export interface LockfileNoteOptions {
  /** Extra hosts to trust, from the repo's `registries` setting (base commit). */
  trustedHosts?: readonly string[];
}

interface DownloadUrl {
  scheme: string;
  host: string;
  path: string;
  line: number | undefined;
}

function isComposer(path: string): boolean {
  return path === "composer.lock" || path.endsWith("/composer.lock");
}

/** Download URLs on the hunk's added or removed lines. */
function downloadUrls(hunk: Hunk, kind: "add" | "del"): DownloadUrl[] {
  const found: DownloadUrl[] = [];
  let block = "";
  for (const line of hunk.lines) {
    const opened = BLOCK_OPEN.exec(line.text) ?? TOML_TABLE.exec(line.text);
    if (opened?.[1] !== undefined) block = opened[1].toLowerCase();
    if (line.kind !== kind) continue;
    const isDownload =
      DOWNLOAD_KEY.test(line.text) ||
      (URL_KEY.test(line.text) && (block === "dist" || block === "source"));
    if (!isDownload || line.text.includes(CARGO_INDEX)) continue;
    for (const match of line.text.matchAll(URL_PATTERN)) {
      const [, scheme = "", host = "", path = ""] = match;
      found.push({
        scheme: scheme.toLowerCase().replace(/^git\+/, ""),
        host: host.toLowerCase(),
        path,
        line: kind === "add" ? line.newLine : line.oldLine,
      });
    }
  }
  return found;
}

/** `owner/repo` of a Git host URL (`/repos/owner/repo/...` on api.github.com). */
function repoOf(url: DownloadUrl): string | undefined {
  if (!GIT_HOSTS.has(url.host)) return undefined;
  const parts = url.path.split("/").filter((part) => part !== "");
  const [owner, repo] =
    url.host === "api.github.com" && parts[0] === "repos" ? parts.slice(1) : parts;
  if (owner === undefined || repo === undefined) return undefined;
  return `${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase();
}

/** Counts by key, keeping the first line each was seen on. */
function tally(
  items: { key: string; line: number | undefined }[],
): { key: string; count: number; firstLine: number | undefined }[] {
  const byKey = new Map<string, { key: string; count: number; firstLine: number | undefined }>();
  for (const { key, line } of items) {
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, { key, count: 1, firstLine: line });
    else seen.count += 1;
  }
  return [...byKey.values()];
}

function packages(count: number, verb: string): string {
  return count === 1 ? `1 package ${verb}s` : `${count} packages ${verb}`;
}

/**
 * Added downloads of a repository whose owner changed in the same hunk: the same repo name
 * from a different owner, as when a package is swapped for a fork. A different repo name is a
 * different package (an add next to an update), not a swap.
 */
function repoChanges(hunk: Hunk): string[] {
  const ownersByName = new Map<string, Set<string>>();
  for (const url of downloadUrls(hunk, "del")) {
    const [owner, name] = repoOf(url)?.split("/") ?? [];
    if (owner === undefined || name === undefined) continue;
    ownersByName.set(name, (ownersByName.get(name) ?? new Set()).add(owner));
  }
  return downloadUrls(hunk, "add").flatMap((url) => {
    const [owner, name] = repoOf(url)?.split("/") ?? [];
    const before = name === undefined ? undefined : ownersByName.get(name);
    if (owner === undefined || before === undefined || before.has(owner)) return [];
    const was = [...before].map((o) => `${o}/${name}`).join(", ");
    return [
      `line ${url.line ?? "?"}: now downloads from ${url.host}/${owner}/${name}, replacing ${was}`,
    ];
  });
}

/** The last version string on a line, ignoring checksum tokens (go.sum holds both). */
function lineVersion(text: string): string | undefined {
  return text.replace(CHECKSUM_TOKEN, " ").match(VERSION)?.at(-1);
}

/**
 * Checksums that changed while the version they belong to didn't. Each checksum line is paired
 * with the version nearest above it on its own side (or on its own line), so a checksum swap
 * next to a legitimate bump in the same hunk is still found.
 */
function sameVersionChecksums(hunk: Hunk): string[] {
  const before = new Map<string, string>();
  const after = new Map<string, { text: string; line: number | undefined; version: string }>();
  let oldVersion = "";
  let newVersion = "";
  for (const line of hunk.lines) {
    const version = lineVersion(line.text);
    if (version !== undefined) {
      if (line.kind !== "add") oldVersion = version;
      if (line.kind !== "del") newVersion = version;
    }
    if (line.kind === "context" || !INTEGRITY.test(line.text)) continue;
    const rest = line.text.replace(CHECKSUM_TOKEN, " ").trim();
    if (line.kind === "del") before.set(`${oldVersion}|${rest}`, line.text.trim());
    else
      after.set(`${newVersion}|${rest}`, {
        text: line.text.trim(),
        line: line.newLine,
        version: newVersion,
      });
  }
  return [...after].flatMap(([key, { text, line, version }]) => {
    const was = before.get(key);
    if (was === undefined || was === text) return [];
    const of = version === "" ? "" : ` (version ${version})`;
    return [`line ${line ?? "?"}: a checksum changed with no version change${of}`];
  });
}

/**
 * What a reviewer should know about a lockfile change without reading it: packages resolved
 * from hosts that aren't known or trusted (one note per host), downloads without TLS, downloads
 * moved to a fork (same repo, new owner), and checksums that changed without a version change
 * (the same version from different contents). Lockfiles stay out of
 * the prompt; these notes go in the review summary.
 */
export function lockfileNotes(file: FileDiff, options: LockfileNoteOptions = {}): string[] {
  const trusted = new Set([
    ...KNOWN_PACKAGE_HOSTS,
    ...(isComposer(file.path) ? COMPOSER_HOSTS : []),
    ...(options.trustedHosts ?? []).map((host) => host.toLowerCase()),
  ]);
  const added = file.hunks.flatMap((hunk) => downloadUrls(hunk, "add"));
  const hostNotes = tally(
    added.filter((url) => !trusted.has(url.host)).map((url) => ({ key: url.host, line: url.line })),
  ).map(
    ({ key, count, firstLine }) =>
      `${packages(count, "resolve")} from ${key}, not a known registry (first at line ${firstLine ?? "?"})`,
  );
  const plainNotes = tally(
    added
      .filter((url) => PLAIN_SCHEMES.has(url.scheme))
      .map((url) => ({ key: `${url.scheme}://${url.host}`, line: url.line })),
  ).map(
    ({ key, count, firstLine }) =>
      `${packages(count, "download")} over ${key} without TLS (first at line ${firstLine ?? "?"})`,
  );
  const repoNotes = [...new Set(file.hunks.flatMap(repoChanges))];
  const checksumNotes = file.hunks.flatMap(sameVersionChecksums);
  return [...hostNotes, ...plainNotes, ...repoNotes, ...checksumNotes];
}

/** The note for a binary lockfile, which can't be scanned. */
export const BINARY_LOCKFILE_NOTE =
  "binary lockfile changed and can't be checked for swapped dependencies; consider the text lockfile (bun.lock for Bun)";
