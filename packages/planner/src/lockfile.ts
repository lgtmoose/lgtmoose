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
const VERSION = /\d+\.\d+\.\d+[\w.+-]*/g;

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

/** Added downloads from a different Git repository than the ones they replace in the hunk. */
function repoChanges(hunk: Hunk): string[] {
  const before = new Set(downloadUrls(hunk, "del").flatMap((url) => repoOf(url) ?? []));
  if (before.size === 0) return [];
  return downloadUrls(hunk, "add").flatMap((url) => {
    const repo = repoOf(url);
    if (repo === undefined || before.has(repo)) return [];
    return [
      `line ${url.line ?? "?"}: now downloads from ${url.host}/${repo}, replacing ${[...before].join(", ")}`,
    ];
  });
}

function versions(lines: Hunk["lines"]): string {
  return lines
    .flatMap((line) => line.text.replace(CHECKSUM_TOKEN, " ").match(VERSION) ?? [])
    .sort()
    .join(" ");
}

/** A checksum changed in the hunk while its version strings stayed the same. */
function sameVersionChecksum(hunk: Hunk): string | undefined {
  const added = hunk.lines.filter((line) => line.kind === "add");
  const removed = hunk.lines.filter((line) => line.kind === "del");
  const integrityChanged =
    added.some((line) => INTEGRITY.test(line.text)) &&
    removed.some((line) => INTEGRITY.test(line.text));
  if (!integrityChanged || versions(added) !== versions(removed)) return undefined;
  const end = hunk.newStart + Math.max(hunk.newLines - 1, 0);
  return `lines ${hunk.newStart}-${end}: a checksum changed with no version change`;
}

/**
 * What a reviewer should know about a lockfile change without reading it: packages resolved
 * from hosts that aren't known or trusted (one note per host), downloads without TLS, downloads
 * moved to a different Git repository, and checksums that changed without a version change
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
  const checksumNotes = file.hunks.flatMap((hunk) => {
    const note = sameVersionChecksum(hunk);
    return note === undefined ? [] : [note];
  });
  return [...hostNotes, ...plainNotes, ...repoNotes, ...checksumNotes];
}

/** The note for a binary lockfile, which can't be scanned. */
export const BINARY_LOCKFILE_NOTE =
  "binary lockfile changed and can't be checked for swapped dependencies; consider the text lockfile (bun.lock for Bun)";
