import type { FileDiff, Hunk } from "@lgtmoose/git";

/**
 * Hosts packages normally download from. A lockfile line that resolves a package anywhere else
 * is worth a look; it may be a private registry, or a dependency swapped for a lookalike.
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

const URL_PATTERN = /\b(?:https?|git\+https?|git\+ssh|ssh|git):\/\/(?:[^@/\s"']+@)?([^/:\s"']+)/gi;
const INTEGRITY = /\b(integrity|checksum|resolution|sha(?:1|256|384|512)-|h1:)/i;
const VERSION = /\d+\.\d+\.\d+[\w.+-]*/g;

function hostsIn(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].flatMap((match) =>
    match[1] ? [match[1].toLowerCase()] : [],
  );
}

function hunkNotes(hunk: Hunk): string[] {
  const added = hunk.lines.filter((line) => line.kind === "add");
  const removed = hunk.lines.filter((line) => line.kind === "del");
  const notes: string[] = [];
  for (const line of added) {
    for (const host of hostsIn(line.text)) {
      if (!KNOWN_PACKAGE_HOSTS.includes(host)) {
        notes.push(`line ${line.newLine ?? "?"}: resolves from ${host}, not a known registry`);
      }
    }
  }
  const integrityChanged =
    added.some((line) => INTEGRITY.test(line.text)) &&
    removed.some((line) => INTEGRITY.test(line.text));
  // Same version strings on both sides (outside checksum lines) means no version changed, even
  // if a line holding one, such as a resolved URL, was rewritten.
  const versions = (lines: typeof added) =>
    lines
      .filter((line) => !INTEGRITY.test(line.text))
      .flatMap((line) => line.text.match(VERSION) ?? [])
      .sort()
      .join(" ");
  const versionChanged = versions(added) !== versions(removed);
  if (integrityChanged && !versionChanged) {
    notes.push(
      `lines ${hunk.newStart}-${hunk.newStart + Math.max(hunk.newLines - 1, 0)}: a checksum changed with no version change`,
    );
  }
  return notes;
}

/**
 * What a reviewer should know about a lockfile change without reading it: packages resolved
 * from hosts outside `KNOWN_PACKAGE_HOSTS`, and checksums that changed without a version change
 * (the same version from different contents). Lockfiles stay out of the prompt; these notes go
 * in the review summary.
 */
export function lockfileNotes(file: FileDiff): string[] {
  return [...new Set(file.hunks.flatMap(hunkNotes))];
}
