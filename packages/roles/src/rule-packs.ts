import { readdir, readFile } from "node:fs/promises";
import { PROTECTED_CATEGORIES, SEVERITIES, severityRank } from "@lgtmoose/core";
import type { Repo } from "@lgtmoose/git";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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
  rules: readonly PackRule[],
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
        // The rule is one or two sentences: kept on one line, so it can't start a heading.
        (rule) =>
          `- ${rule.id} (default severity: ${rule.severity}): ${rule.rule.replace(/\s+/g, " ")}\n  Example:\n\n${indent(rule.example, "      ")}`,
      ),
    ].join("\n\n"),
  );
  return [`# ${title}`, description, body, ...sections]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
}

/** A pack file, parsed and checked but not yet rendered. */
interface ParsedPack {
  title: string;
  description: string | undefined;
  body: string;
  rules: PackRule[];
}

function parsePackFile(text: string, name: string, source: RulePackSource): ParsedPack {
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
  }
  return { title: pack.title, description: pack.description, body: parts.body, rules: pack.rules };
}

function toPack(parsed: ParsedPack, id: string, source: RulePackSource): RulePack {
  return {
    id,
    title: parsed.title,
    source,
    rules: parsed.rules,
    text: renderPack(parsed.title, parsed.description, parsed.body, parsed.rules),
  };
}

/**
 * Parses and checks one pack file. `name` is what the pack is called in messages and its id;
 * for built-in and private packs, the id its front matter must have.
 */
export function parseRulePack(text: string, name: string, source: RulePackSource): RulePack {
  return toPack(parsePackFile(text, name, source), name, source);
}

/**
 * The least severe a repo pack's rule may be, per category: blocking in a protected category,
 * and elsewhere the least severe the trusted packs already use for that category. A repo pack
 * can add rules and make them stricter, but can't add a softer rule next to a built-in one.
 */
export function severityFloors(trusted: readonly RulePack[]): Map<string, number> {
  const floors = new Map<string, number>();
  for (const pack of trusted) {
    for (const rule of pack.rules) {
      const rank = severityRank(rule.severity);
      floors.set(rule.category, Math.max(floors.get(rule.category) ?? 0, rank));
    }
  }
  for (const category of PROTECTED_CATEGORIES) floors.set(category, severityRank("blocking"));
  return floors;
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

/** The ids in each folder. A built-in id wins over a private one with the same name. */
interface PackIndex {
  dirs: RulePackDirs;
  builtin: string[];
  private: string[];
}

async function indexPacks(dirs: RulePackDirs): Promise<PackIndex> {
  const [builtin, priv] = await Promise.all([idsIn(dirs.builtin), idsIn(dirs.private)]);
  return { dirs, builtin, private: priv };
}

function available(index: PackIndex): string[] {
  return [...new Set([...index.builtin, ...index.private])].sort();
}

async function loadIndexed(id: string, index: PackIndex): Promise<RulePack> {
  if (RULE_PACK_ID.test(id) && index.builtin.includes(id)) {
    const text = await readFile(new URL(`${id}.md`, index.dirs.builtin), "utf8");
    return parseRulePack(text, id, "builtin");
  }
  if (RULE_PACK_ID.test(id) && index.private.includes(id)) {
    const text = await readFile(new URL(`${id}.md`, index.dirs.private), "utf8");
    return parseRulePack(text, id, "private");
  }
  throw new RulePackError(
    `Unknown rule pack "${id}". Available rule packs: ${available(index).join(", ")}.`,
  );
}

/** Ids of the built-in and private packs, sorted. */
export async function availableRulePacks(dirs: RulePackDirs = DEFAULT_DIRS): Promise<string[]> {
  return available(await indexPacks(dirs));
}

/** Loads one built-in or private pack by id. Throws a RulePackError for a bad or unknown id. */
export async function loadRulePack(
  id: string,
  dirs: RulePackDirs = DEFAULT_DIRS,
): Promise<RulePack> {
  return loadIndexed(id, await indexPacks(dirs));
}

/** Loads built-in or private packs in the order given, once each. Throws on the first bad one. */
export async function loadRulePacks(
  ids: readonly string[],
  dirs: RulePackDirs = DEFAULT_DIRS,
): Promise<RulePack[]> {
  const index = await indexPacks(dirs);
  return Promise.all([...new Set(ids)].map((id) => loadIndexed(id, index)));
}

export interface SelectRulePacksOptions {
  /** The reviewed repo, and the base commit its repo packs are read from. */
  repo?: Pick<Repo, "git" | "readBlobs">;
  baseSha?: string;
  dirs?: RulePackDirs;
}

export interface SelectedRulePacks {
  packs: RulePack[];
  /** Entries, or rules, that couldn't be used, and why. The review goes on without them. */
  problems: string[];
}

/** A pack file directly in the repo's `rules` folder, with a name a pack id allows. */
const RULES_ENTRY =
  /^(100644|100755) blob ([0-9a-f]{40,64}) +(\d+)\t(rules\/[a-z0-9][a-z0-9-]*\.md)$/;

/**
 * Reads the repo packs `wanted` names (paths, or `rules/*.md`) at `sha`, within the limits. A
 * file over the per-file limit is skipped by its size in the tree, without being read, so it
 * doesn't use up the total.
 */
async function readRepoPacks(
  repo: Pick<Repo, "git" | "readBlobs">,
  sha: string,
  wanted: ReadonlySet<string>,
  problems: string[],
): Promise<{ path: string; text: string }[]> {
  const listing = await repo.git(["ls-tree", "-z", "-l", sha, "--", "rules/"]);
  const entries: { path: string; blob: string; size: number }[] = [];
  for (const line of listing.split("\0")) {
    const [, , blob, size, path] = RULES_ENTRY.exec(line) ?? [];
    if (blob === undefined || size === undefined || path === undefined) continue;
    if (wanted.has("rules/*.md") || wanted.has(path))
      entries.push({ path, blob, size: Number(size) });
  }
  entries.sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path));
  for (const path of wanted) {
    if (path !== "rules/*.md" && !entries.some((entry) => entry.path === path)) {
      problems.push(`./${path} isn't in the base branch, or isn't a regular file.`);
    }
  }

  const { maxBytes, maxFiles, maxTotalBytes } = REPO_RULE_PACK_LIMITS;
  const chosen: typeof entries = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.size > maxBytes) {
      problems.push(
        `./${entry.path} was left out: a repo rule pack can be at most ${maxBytes / 1024} KiB.`,
      );
    } else if (chosen.length >= maxFiles || total + entry.size > maxTotalBytes) {
      problems.push(
        `./${entry.path} was left out: repo rule packs are limited to ${maxFiles} files and ${maxTotalBytes / 1024} KiB in all.`,
      );
    } else {
      chosen.push(entry);
      total += entry.size;
    }
  }
  const blobs = await repo.readBlobs(chosen.map((entry) => entry.blob));
  return chosen.flatMap((entry) => {
    const content = blobs.get(entry.blob);
    return content === undefined ? [] : [{ path: entry.path, text: content.toString("utf8") }];
  });
}

/**
 * The packs for one review, from the `rulepacks` list in the base branch's `.lgtmoose.yaml`:
 * the mandatory packs first, then built-in and private packs by id, then repo packs. A bad
 * entry never fails the review: it's left out and reported in `problems`, and so is a repo
 * rule softer than the trusted packs allow (see `severityFloors`).
 */
export async function selectRulePacks(
  entries: readonly string[],
  options: SelectRulePacksOptions = {},
): Promise<SelectedRulePacks> {
  const index = await indexPacks(options.dirs ?? DEFAULT_DIRS);
  const problems: string[] = [];
  const named: string[] = [...MANDATORY_RULE_PACKS];
  const repoPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith("./")) {
      const match = REPO_PACK_ENTRY.exec(entry);
      if (match === null) {
        problems.push(`"${entry}" isn't a repo rule pack: use ./rules/<name>.md or ./rules/*.md.`);
      } else {
        repoPaths.add(`rules/${match[1]}.md`);
      }
    } else if (!named.includes(entry)) {
      named.push(entry);
    }
  }

  for (const id of named.filter((id) => index.builtin.includes(id) && index.private.includes(id))) {
    problems.push(
      `The private rule pack "${id}" has a built-in pack's id, so the built-in one is used.`,
    );
  }
  // Loaded together; problems are reported in the list's order, not the order loads finish.
  const loaded = await Promise.all(
    named.map((id) =>
      loadIndexed(id, index).catch((error: unknown) => {
        if (!(error instanceof RulePackError)) throw error;
        return error;
      }),
    ),
  );
  const packs: RulePack[] = [];
  for (const result of loaded) {
    if (result instanceof RulePackError) problems.push(result.message);
    else packs.push(result);
  }

  if (repoPaths.size > 0) {
    if (options.repo === undefined || options.baseSha === undefined) {
      problems.push("Repo rule packs need the repository; they were left out.");
      return { packs, problems };
    }
    const floors = severityFloors(packs);
    for (const file of await readRepoPacks(options.repo, options.baseSha, repoPaths, problems)) {
      const name = `./${file.path}`;
      let parsed: ParsedPack;
      try {
        parsed = parsePackFile(file.text, name, "repo");
      } catch (error) {
        if (!(error instanceof RulePackError)) throw error;
        problems.push(error.message);
        continue;
      }
      const rules = parsed.rules.filter((rule) => {
        const floor = floors.get(rule.category);
        if (floor === undefined || severityRank(rule.severity) <= floor) return true;
        problems.push(
          `${name}: rule ${rule.id} was left out: a repo rule in ${rule.category} can't be softer than ${SEVERITIES[floor]}.`,
        );
        return false;
      });
      if (rules.length > 0) packs.push(toPack({ ...parsed, rules }, name, "repo"));
    }
  }
  return { packs, problems };
}
