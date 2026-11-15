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
    /**
     * Labels for the report, such as `cross-file` for bugs only a pass over the whole PR can
     * see (an unused export, a setting nothing defines). Recall is also shown per tag.
     */
    tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "tags are lowercase words")).default([]),
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

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

/** A file's text in the fixture: the head's version (`head/`, else `base/`), or the base's. */
async function fixtureFile(
  fixture: Pick<Fixture, "dir" | "deleted">,
  path: string,
  side: "LEFT" | "RIGHT",
): Promise<string | undefined> {
  const read = (dir: string) =>
    readFile(join(fixture.dir, dir, path), "utf8").catch(() => undefined);
  if (side === "LEFT") return read("base");
  if (fixture.deleted.includes(path)) return undefined;
  return (await read("head")) ?? (await read("base"));
}

function lineCount(text: string): number {
  // A trailing newline ends the last line rather than starting another.
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * Mistakes that would make a fixture score wrongly, as messages; empty when there are none:
 * - an expected bug or protected range on a file or lines the fixture doesn't have;
 * - an expected bug in a file the PR doesn't change: findings can only be posted on its diff;
 * - a deleted file that isn't in the base.
 */
export async function fixtureProblems(fixture: Fixture): Promise<string[]> {
  const problems: string[] = [];
  const check = async (
    what: string,
    path: string,
    side: "LEFT" | "RIGHT",
    lines: readonly [number, number] | undefined,
  ) => {
    const text = await fixtureFile(fixture, path, side);
    if (text === undefined) {
      problems.push(`${what} ${path} isn't in the ${side === "LEFT" ? "base" : "head"}`);
      return;
    }
    if (lines !== undefined && lines[1] > lineCount(text)) {
      problems.push(`${what} ${path}:${lines.join("-")} is past the file's last line`);
    }
  };
  for (const expected of fixture.expected) {
    await check("expected", expected.path, expected.side, expected.lines);
    const changed =
      (await isFile(join(fixture.dir, "head", expected.path))) ||
      (expected.side === "LEFT" && fixture.deleted.includes(expected.path));
    if (!changed) problems.push(`expected ${expected.path} isn't changed by the PR`);
  }
  for (const rule of fixture.mustNotFlag) {
    await check("mustNotFlag", rule.path, "RIGHT", rule.lines);
  }
  for (const path of fixture.deleted) {
    if ((await fixtureFile(fixture, path, "LEFT")) === undefined) {
      problems.push(`deleted ${path} isn't in the base`);
    }
  }
  return problems;
}

/**
 * Loads every fixture under each root (one directory per fixture), sorted by name. Several
 * roots let a fork run private fixtures, kept outside this repository, with the public ones;
 * names must be unique across them. Each fixture is checked with `fixtureProblems`.
 */
export async function loadFixtures(roots: string | readonly string[]): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  const seen = new Map<string, string>();
  for (const root of typeof roots === "string" ? [roots] : roots) {
    if (!(await isDir(root))) throw new Error(`Fixture directory ${root} doesn't exist.`);
    for (const name of (await readdir(root)).sort()) {
      const dir = join(root, name);
      if (!(await isDir(dir))) continue;
      const other = seen.get(name);
      if (other !== undefined) {
        throw new Error(`Fixture ${name} is in both ${other} and ${root}; names must be unique.`);
      }
      seen.set(name, root);
      const text = await readFile(join(dir, "fixture.json"), "utf8");
      const parsed = fixtureSpecSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error(`Fixture ${name}: ${z.prettifyError(parsed.error)}`);
      if (!(await isDir(join(dir, "base")))) {
        throw new Error(`Fixture ${name} has no base/ directory.`);
      }
      const fixture = { ...parsed.data, name, dir };
      const problems = await fixtureProblems(fixture);
      if (problems.length > 0) throw new Error(`Fixture ${name}: ${problems.join("; ")}.`);
      fixtures.push(fixture);
    }
  }
  return fixtures.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name));
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
export async function buildFixtureRepo(
  fixture: Pick<Fixture, "name" | "dir" | "title" | "deleted">,
  root: string,
): Promise<FixtureRepo> {
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
