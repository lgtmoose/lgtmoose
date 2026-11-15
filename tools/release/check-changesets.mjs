#!/usr/bin/env node
// The changeset gate for pull requests (.github/workflows/release.yml). LGTMoose has one version,
// the `lgtmoose` package's (see .changeset/README.md), so:
//
// - a pull request that changes code under apps/, packages/ or infra/ must add a changeset,
//   which may be an empty one (`pnpm changeset --empty`);
// - every changeset may name only `lgtmoose`. The other workspace packages are private parts of
//   the same product and stay at 0.0.0.
//
//   node tools/release/check-changesets.mjs <base-ref>   check the changes since <base-ref>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The one package a changeset may bump. */
export const PRODUCT = "lgtmoose";

/** Paths whose changes need a changeset. */
const CODE = /^(apps|packages|infra)\//;

/** A changeset file: `.changeset/<name>.md`, apart from the folder's README. */
export function isChangeset(path) {
  return /^\.changeset\/[^/]+\.md$/.test(path) && path !== ".changeset/README.md";
}

/**
 * The packages a changeset's front matter bumps. An empty changeset (`---\n---`) bumps none.
 * Throws when the file has no front matter.
 */
export function bumpedPackages(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---/.exec(text);
  if (match === null) throw new Error("has no front matter (a --- block at the top)");
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const entry = /^["']?([^"':]+)["']?\s*:\s*(patch|minor|major)\s*$/.exec(line);
      if (entry === null) throw new Error(`has a line that isn't "<package>": patch|minor|major`);
      return entry[1];
    });
}

/**
 * The gate's problems for a pull request, given the paths it changes (added, modified, deleted)
 * and a reader for files at its head. No problems means it passes.
 */
export function check(changed, read) {
  const problems = [];
  const added = changed.filter(isChangeset);
  for (const path of added) {
    let packages;
    try {
      packages = bumpedPackages(read(path));
    } catch (error) {
      problems.push(`${path} ${error.message}.`);
      continue;
    }
    const others = packages.filter((name) => name !== PRODUCT);
    if (others.length > 0) {
      problems.push(
        `${path} bumps ${others.join(", ")}. A changeset names only "${PRODUCT}": LGTMoose has one version.`,
      );
    }
  }
  if (added.length === 0 && changed.some((path) => CODE.test(path))) {
    problems.push(
      "This pull request changes code under apps/, packages/ or infra/ but adds no changeset. " +
        "Run `pnpm changeset` (or `pnpm changeset --empty` for a change nobody running LGTMoose " +
        "would notice) and commit the file it writes.",
    );
  }
  return problems;
}

function main(base) {
  if (base === undefined) throw new Error("Usage: check-changesets.mjs <base-ref>");
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...HEAD`],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter((line) => line !== "");
  // Deleted changesets (consumed by a version PR) aren't read.
  const present = new Set(
    execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line !== ""),
  );
  const problems = check(
    changed.filter((path) => !isChangeset(path) || present.has(path)),
    (path) => readFileSync(path, "utf8"),
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("Changesets are in order.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2]);
