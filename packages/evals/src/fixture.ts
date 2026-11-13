import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SEVERITIES } from "@lgtmoose/core";
import { z } from "zod";

const exec = promisify(execFile);

const lineRange = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([start, end]) => start <= end, {
    message: "a line range's start can't be after its end",
  });

/** A path inside the fixture's repo: relative, no `..`, no backslashes. */
const repoPath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
    { message: "paths are relative to the repo, without `..`" },
  );

/**
 * A problem the reviewer should report: on `path`, overlapping `lines` (both ends included) on
 * `side` (RIGHT, the head, by default; LEFT for a removed line, numbered as in the base), in
 * `category` (a rule category, or a list of them that would all be right).
 */
export const expectedFindingSchema = z
  .object({
    category: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    path: repoPath,
    lines: lineRange,
    side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
    severity: z.enum(SEVERITIES),
    /** What the seeded bug is, for the report. */
    note: z.string().optional(),
  })
  .strict();

/**
 * Code the reviewer must not flag: a blocking or should-fix finding on `path` (within `lines`
 * when given, and in one of `categories` when given) is a false positive.
 */
export const mustNotFlagSchema = z
  .object({
    path: repoPath,
    lines: lineRange.optional(),
    categories: z.array(z.string().min(1)).min(1).optional(),
    note: z.string().optional(),
  })
  .strict();

/**
 * `fixture.json`, next to `base/` (the repo before the PR) and an optional `head/` (files the
 * PR adds or changes, laid over the base). `seeded` fixtures hold bugs the reviewer should find;
 * `clean` ones hold none, and a blocking or should-fix finding on one is a false positive.
 */
export const fixtureSpecSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().default(""),
    kind: z.enum(["seeded", "clean"]),
    expected: z.array(expectedFindingSchema).default([]),
    mustNotFlag: z.array(mustNotFlagSchema).default([]),
    /** Files the PR deletes. */
    deleted: z.array(repoPath).default([]),
  })
  .strict()
  .refine((spec) => spec.kind === "clean" || spec.expected.length > 0, {
    message: "a seeded fixture needs at least one expected finding",
  })
  .refine((spec) => spec.kind === "seeded" || spec.expected.length === 0, {
    message: "a clean fixture can't expect findings",
  });

export type ExpectedFinding = z.infer<typeof expectedFindingSchema>;
export type MustNotFlag = z.infer<typeof mustNotFlagSchema>;
export type FixtureSpec = z.infer<typeof fixtureSpecSchema>;

export interface Fixture extends FixtureSpec {
  /** The fixture's directory name. */
  name: string;
  dir: string;
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

/** Loads every fixture under `root` (one directory each), sorted by name. */
export async function loadFixtures(root: string): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  for (const name of (await readdir(root)).sort()) {
    const dir = join(root, name);
    if (!(await isDir(dir))) continue;
    const text = await readFile(join(dir, "fixture.json"), "utf8");
    const parsed = fixtureSpecSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`Fixture ${name}: ${z.prettifyError(parsed.error)}`);
    if (!(await isDir(join(dir, "base")))) {
      throw new Error(`Fixture ${name} has no base/ directory.`);
    }
    fixtures.push({ ...parsed.data, name, dir });
  }
  return fixtures;
}

export interface FixtureRepo {
  /** A file:// URL for a bare repo that allows partial clones and fetching by SHA, like GitHub. */
  url: string;
  baseSha: string;
  headSha: string;
}

/** Fixed names and dates, so a fixture's commits are the same on every run. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "LGTMoose evals",
  GIT_AUTHOR_EMAIL: "evals@lgtmoose.invalid",
  GIT_COMMITTER_NAME: "LGTMoose evals",
  GIT_COMMITTER_EMAIL: "evals@lgtmoose.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

/**
 * Builds the fixture's repository under `root` (an empty or missing directory): a commit of
 * `base/`, then a commit with `head/` laid over it and `deleted` removed, both pushed to a bare
 * remote that the pipeline clones over file://, as it would from GitHub.
 */
export async function buildFixtureRepo(fixture: Fixture, root: string): Promise<FixtureRepo> {
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  await mkdir(root, { recursive: true });
  await exec("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  for (const key of ["uploadpack.allowFilter", "uploadpack.allowAnySHA1InWant"]) {
    await git(remote, "config", key, "true");
  }
  await exec("git", ["init", "--quiet", "--initial-branch=main", work]);
  await git(work, "config", "commit.gpgsign", "false");
  await git(work, "remote", "add", "origin", remote);

  await cp(join(fixture.dir, "base"), work, { recursive: true });
  await git(work, "add", "--all");
  await git(work, "commit", "--quiet", "-m", "base");
  const baseSha = await git(work, "rev-parse", "HEAD");

  await git(work, "checkout", "--quiet", "-b", "pr");
  if (await isDir(join(fixture.dir, "head"))) {
    await cp(join(fixture.dir, "head"), work, { recursive: true });
  }
  const top = resolve(work);
  for (const path of fixture.deleted) {
    const full = resolve(work, path);
    if (!full.startsWith(`${top}${sep}`)) {
      throw new Error(`Fixture ${fixture.name}: ${path} is outside the repo.`);
    }
    await rm(full, { force: true });
  }
  await git(work, "add", "--all");
  await git(work, "commit", "--quiet", "--allow-empty", "-m", fixture.title);
  const headSha = await git(work, "rev-parse", "HEAD");
  await git(work, "push", "--quiet", "--all", "origin");
  return { url: pathToFileURL(remote).href, baseSha, headSha };
}
