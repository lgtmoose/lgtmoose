import { readdir, readFile } from "node:fs/promises";
import { PROTECTED_CATEGORIES, SEVERITIES } from "@lgtmoose/core";
import type { Repo } from "@lgtmoose/git";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { readConventionFilesAt } from "./conventions.js";

/**
 * Rule packs are markdown files with YAML front matter: the pack's id, title and rules, each
 * with a category, a default severity and a short example. The body after the front matter is
 * optional guidance for the whole pack. There are three sources:
 *
 * - built-in packs in the package's `rulepacks` folder;
 * - private packs in `rulepacks/private`, which a fork adds without changing code. Both ship in
 *   the control image, and both are trusted: they're written by whoever deploys LGTMoose;
 * - repo packs, `./rules/<name>.md` in the reviewed repo, named in its `.lgtmoose.yaml`. They're
 *   repository content, so they're read from the base branch (a PR can't change the rules it's
 *   reviewed against), capped in size, and shown to the model as untrusted data that can only
 *   add rules.
 *
 * `generic` and `security` are always on, whatever the repo's config says.
 */
export const RULE_PACK_DIR = new URL("../rulepacks/", import.meta.url);
export const PRIVATE_RULE_PACK_DIR = new URL("private/", RULE_PACK_DIR);

/** Packs a repo's config can't turn off. */
export const MANDATORY_RULE_PACKS = ["generic", "security"] as const;

/** Limits for repo packs, which come from repository content. */
export const REPO_RULE_PACK_LIMITS = {
  /** Bytes in one pack file. A longer file is skipped, not cut: cut YAML doesn't parse. */
  maxBytes: 16 * 1024,
  maxFiles: 10,
  maxTotalBytes: 48 * 1024,
} as const;

export type RulePackSource = "builtin" | "private" | "repo";

export interface PackRule {
  id: string;
  category: string;
  severity: (typeof SEVERITIES)[number];
  rule: string;
  example: string;
}

export interface RulePack {
  /** The pack's id; for a repo pack, its path in the repo, such as `./rules/billing.md`. */
  id: string;
  title: string;
  source: RulePackSource;
  rules: PackRule[];
  /** The pack rendered as markdown for the prompt. */
  text: string;
}

/** Ids name files, but come from a repo's `.lgtmoose.yaml`, so they never name a path. */
const RULE_PACK_ID = /^[a-z0-9][a-z0-9-]*$/;
/** A repo pack entry in `.lgtmoose.yaml`: one file in the repo's `rules` folder, or all of them. */
const REPO_PACK_ENTRY = /^\.\/rules\/([a-z0-9][a-z0-9-]*|\*)\.md$/;

const ruleSchema = z
  .object({
    id: z.string().regex(RULE_PACK_ID, "rule ids are lowercase letters, digits and hyphens"),
    // The same shape as a finding's rule_category, so a rule's category can be reported as is.
    category: z.string().regex(/^[a-z][a-z0-9_]*$/, "categories are lowercase snake_case"),
    severity: z.enum(SEVERITIES),
    rule: z.string().trim().min(1).max(1000),
    example: z.string().trim().min(1).max(1500),
  })
  .strict();

const packSchema = z
  .object({
    id: z.string().regex(RULE_PACK_ID).optional(),
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).optional(),
    rules: z.array(ruleSchema).min(1).max(60),
  })
  .strict();

export class RulePackError extends Error {
  override name = "RulePackError";
}

/** Splits `---` front matter from the body. */
function splitFrontMatter(text: string): { front: string; body: string } | undefined {
  const normalised = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalised);
  return match === null ? undefined : { front: match[1] ?? "", body: (match[2] ?? "").trim() };
}

/** Indents every line, so an example renders as a code block whatever it contains. */
function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `${by}${line}`))
    .join("\n");
}

/** Renders a pack for the prompt: rules grouped by category, in the order they first appear. */
function renderPack(
  title: string,
  description: string | undefined,
  body: string,
  rules: PackRule[],
): string {
  const byCategory = new Map<string, PackRule[]>();
  for (const rule of rules) {
    const group = byCategory.get(rule.category);
    if (group === undefined) byCategory.set(rule.category, [rule]);
    else group.push(rule);
  }
  const sections = [...byCategory].map(([category, group]) =>
    [
      `## ${category}`,
      ...group.map(
        (rule) =>
          `- ${rule.id} (default severity: ${rule.severity}): ${rule.rule}\n  Example:\n\n${indent(rule.example, "      ")}`,
      ),
    ].join("\n\n"),
  );
  return [`# ${title}`, description, body, ...sections]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
}

/**
 * Parses and checks one pack file. `name` is what the pack is called in messages and, for
 * built-in and private packs, the id its front matter must have.
 */
export function parseRulePack(text: string, name: string, source: RulePackSource): RulePack {
  const parts = splitFrontMatter(text);
  if (parts === undefined) {
    throw new RulePackError(`Rule pack ${name} has no front matter (a --- block at the top).`);
  }
  let data: unknown;
  try {
    // Aliases are capped so a small file can't expand into a huge one.
    data = parseYaml(parts.front, { maxAliasCount: 20 });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new RulePackError(`Rule pack ${name}: its front matter isn't valid YAML (${reason}).`);
  }
  const parsed = packSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new RulePackError(`Rule pack ${name} is invalid: ${issues.join("; ")}.`);
  }
  const pack = parsed.data;
  if (source !== "repo" && pack.id !== name) {
    throw new RulePackError(`Rule pack ${name}: its front matter id must be "${name}".`);
  }
  const seen = new Set<string>();
  for (const rule of pack.rules) {
    if (seen.has(rule.id)) throw new RulePackError(`Rule pack ${name} has rule ${rule.id} twice.`);
    seen.add(rule.id);
    // A repo pack can add rules in a protected category, but not soften one.
    if (
      source === "repo" &&
      PROTECTED_CATEGORIES.includes(rule.category) &&
      rule.severity !== "blocking"
    ) {
      throw new RulePackError(
        `Rule pack ${name}: rule ${rule.id} is in the protected category ${rule.category}, so its severity must be blocking.`,
      );
    }
  }
  const id = source === "repo" ? name : (pack.id ?? name);
  return {
    id,
    title: pack.title,
    source,
    rules: pack.rules,
    text: renderPack(pack.title, pack.description, parts.body, pack.rules),
  };
}

async function idsIn(dir: URL): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .filter((id) => RULE_PACK_ID.test(id))
    .sort();
}

/** Where built-in and private packs are read from. Tests point these at fixtures. */
export interface RulePackDirs {
  builtin: URL;
  private: URL;
}

const DEFAULT_DIRS: RulePackDirs = { builtin: RULE_PACK_DIR, private: PRIVATE_RULE_PACK_DIR };

/** Ids of the built-in and private packs, sorted. A private id that clashes with a built-in one is left out. */
export async function availableRulePacks(dirs: RulePackDirs = DEFAULT_DIRS): Promise<string[]> {
  const [builtin, priv] = await Promise.all([idsIn(dirs.builtin), idsIn(dirs.private)]);
  return [...new Set([...builtin, ...priv])].sort();
}

/** Loads one built-in or private pack by id. Throws a RulePackError for a bad or unknown id. */
export async function loadRulePack(
  id: string,
  dirs: RulePackDirs = DEFAULT_DIRS,
): Promise<RulePack> {
  const [builtin, priv] = await Promise.all([idsIn(dirs.builtin), idsIn(dirs.private)]);
  if (RULE_PACK_ID.test(id) && builtin.includes(id)) {
    return parseRulePack(await readFile(new URL(`${id}.md`, dirs.builtin), "utf8"), id, "builtin");
  }
  if (RULE_PACK_ID.test(id) && priv.includes(id)) {
    return parseRulePack(await readFile(new URL(`${id}.md`, dirs.private), "utf8"), id, "private");
  }
  const available = [...new Set([...builtin, ...priv])].sort();
  throw new RulePackError(
    `Unknown rule pack "${id}". Available rule packs: ${available.join(", ")}.`,
  );
}

/** Loads built-in or private packs in the order given, once each. Throws on the first bad one. */
export async function loadRulePacks(
  ids: readonly string[],
  dirs: RulePackDirs = DEFAULT_DIRS,
): Promise<RulePack[]> {
  return Promise.all([...new Set(ids)].map((id) => loadRulePack(id, dirs)));
}

export interface SelectRulePacksOptions {
  /** The reviewed repo, and the base commit its repo packs are read from. */
  repo?: Pick<Repo, "git" | "readBlobs">;
  baseSha?: string;
  dirs?: RulePackDirs;
}

export interface SelectedRulePacks {
  packs: RulePack[];
  /** Entries that couldn't be used, and why. The review goes on without them. */
  problems: string[];
}

/**
 * The packs for one review, from the `rulepacks` list in the base branch's `.lgtmoose.yaml`:
 * the mandatory packs first, then built-in and private packs by id, then repo packs. A bad
 * entry never fails the review: it's left out and reported in `problems`.
 */
export async function selectRulePacks(
  entries: readonly string[],
  options: SelectRulePacksOptions = {},
): Promise<SelectedRulePacks> {
  const dirs = options.dirs ?? DEFAULT_DIRS;
  const problems: string[] = [];
  const named: string[] = [...MANDATORY_RULE_PACKS];
  const repoGlobs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("./")) {
      const match = REPO_PACK_ENTRY.exec(entry);
      if (match === null) {
        problems.push(`"${entry}" isn't a repo rule pack: use ./rules/<name>.md or ./rules/*.md.`);
      } else {
        repoGlobs.push(`rules/${match[1]}.md`);
      }
    } else if (!named.includes(entry)) {
      named.push(entry);
    }
  }

  const [builtin, priv] = await Promise.all([idsIn(dirs.builtin), idsIn(dirs.private)]);
  for (const id of named.filter((id) => builtin.includes(id) && priv.includes(id))) {
    problems.push(
      `The private rule pack "${id}" has a built-in pack's id, so the built-in one is used.`,
    );
  }

  const packs: RulePack[] = [];
  for (const id of named) {
    try {
      packs.push(await loadRulePack(id, dirs));
    } catch (error) {
      if (!(error instanceof RulePackError)) throw error;
      problems.push(error.message);
    }
  }

  if (repoGlobs.length > 0) {
    if (options.repo === undefined || options.baseSha === undefined) {
      problems.push("Repo rule packs need the repository; they were left out.");
    } else {
      const read = await readConventionFilesAt(options.repo, options.baseSha, {
        globs: [...new Set(repoGlobs)],
        ...REPO_RULE_PACK_LIMITS,
      });
      for (const path of read.omitted) {
        problems.push(
          `./${path} was left out: repo rule packs are limited to ${REPO_RULE_PACK_LIMITS.maxFiles} files and ${REPO_RULE_PACK_LIMITS.maxTotalBytes / 1024} KiB.`,
        );
      }
      for (const file of read.files) {
        const name = `./${file.path}`;
        if (file.truncated === true) {
          problems.push(
            `${name} was left out: a repo rule pack can be at most ${REPO_RULE_PACK_LIMITS.maxBytes / 1024} KiB, and all of them ${REPO_RULE_PACK_LIMITS.maxTotalBytes / 1024} KiB.`,
          );
          continue;
        }
        try {
          packs.push(parseRulePack(file.text, name, "repo"));
        } catch (error) {
          if (!(error instanceof RulePackError)) throw error;
          problems.push(error.message);
        }
      }
      for (const glob of new Set(repoGlobs)) {
        if (
          !glob.includes("*") &&
          !read.files.some((file) => file.path === glob) &&
          !read.omitted.includes(glob)
        ) {
          problems.push(`./${glob} isn't in the base branch.`);
        }
      }
    }
  }
  return { packs, problems };
}
