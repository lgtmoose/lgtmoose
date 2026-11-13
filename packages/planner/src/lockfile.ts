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

const URL_PATTERN = /\b(?:https?|git\+https?|git\+ssh|ssh|git):\/\/(?:[^@/\s"']+@)?([^/:\s"']+)/gi;

/**
 * Lines whose URL is where a package is downloaded from. Other URLs (npm's `funding`,
 * `homepage`, `bugs`) are metadata and aren't checked. A bare `url` key only counts inside a
 * composer `dist` or `source` block.
 */
const DOWNLOAD_KEY = /\b(resolved|tarball|resolution|remote|registry\+|git\+|git:\/\/|ssh:\/\/)/i;
const URL_KEY = /^\s*"?url"?\s*[:=]/i;
const BLOCK_OPEN = /"?([\w-]+)"?\s*[:=]\s*[{[]\s*$/;

const INTEGRITY = /\b(integrity|checksum|resolution|sha(?:1|256|384|512)-|h1:)/i;
/** A checksum token on a line, removed before looking for versions (go.sum holds both). */
const CHECKSUM_TOKEN =
  /\b(?:h1:|sha(?:1|256|384|512)[-:=]|10c0\/)[A-Za-z0-9+/=_.-]+|\b(?:integrity|checksum)\b["':=\s]+[A-Za-z0-9+/=_.-]+/gi;
const VERSION = /\d+\.\d+\.\d+[\w.+-]*/g;

export interface LockfileNoteOptions {
  /** Extra hosts to trust, from the repo's `registries` setting (base commit). */
  trustedHosts?: readonly string[];
}

interface UnknownHost {
  host: string;
  count: number;
  firstLine: number | undefined;
}

function isComposer(path: string): boolean {
  return path === "composer.lock" || path.endsWith("/composer.lock");
}

/** The download URLs' hosts on the hunk's added lines that aren't trusted, with their lines. */
function unknownHosts(
  hunk: Hunk,
  trusted: ReadonlySet<string>,
): { host: string; line: number | undefined }[] {
  const found: { host: string; line: number | undefined }[] = [];
  let block = "";
  for (const line of hunk.lines) {
    const opened = BLOCK_OPEN.exec(line.text);
    if (opened?.[1] !== undefined) block = opened[1].toLowerCase();
    if (line.kind !== "add") continue;
    const isDownload =
      DOWNLOAD_KEY.test(line.text) ||
      (URL_KEY.test(line.text) && (block === "dist" || block === "source"));
    if (!isDownload || line.text.includes(CARGO_INDEX)) continue;
    for (const match of line.text.matchAll(URL_PATTERN)) {
      const host = match[1]?.toLowerCase();
      if (host !== undefined && !trusted.has(host)) found.push({ host, line: line.newLine });
    }
  }
  return found;
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
 * from hosts that aren't known or trusted (one note per host), and checksums that changed
 * without a version change (the same version from different contents). Lockfiles stay out of
 * the prompt; these notes go in the review summary.
 */
export function lockfileNotes(file: FileDiff, options: LockfileNoteOptions = {}): string[] {
  const trusted = new Set([
    ...KNOWN_PACKAGE_HOSTS,
    ...(isComposer(file.path) ? COMPOSER_HOSTS : []),
    ...(options.trustedHosts ?? []).map((host) => host.toLowerCase()),
  ]);
  const hosts = new Map<string, UnknownHost>();
  for (const { host, line } of file.hunks.flatMap((hunk) => unknownHosts(hunk, trusted))) {
    const seen = hosts.get(host);
    if (seen === undefined) hosts.set(host, { host, count: 1, firstLine: line });
    else seen.count += 1;
  }
  const hostNotes = [...hosts.values()].map(({ host, count, firstLine }) => {
    const what = count === 1 ? "1 package resolves" : `${count} packages resolve`;
    return `${what} from ${host}, not a known registry (first at line ${firstLine ?? "?"})`;
  });
  const checksumNotes = file.hunks.flatMap((hunk) => {
    const note = sameVersionChecksum(hunk);
    return note === undefined ? [] : [note];
  });
  return [...hostNotes, ...checksumNotes];
}

/** The note for a binary lockfile, which can't be scanned. */
export const BINARY_LOCKFILE_NOTE =
  "binary lockfile changed and can't be checked for swapped dependencies; consider the text lockfile (bun.lock for Bun)";
