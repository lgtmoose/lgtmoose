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
  /** Each problem on its own, for lists that cut long items. Defaults to the message. */
  readonly issues: readonly string[];

  constructor(message: string, issues?: readonly string[]) {
    super(message);
    this.issues = issues ?? [message];
  }
}

/** An id that names no built-in or private pack: the repo's config is wrong. */
class UnknownRulePackError extends RulePackError {
  override name = "UnknownRulePackError";
}

/** Splits `---` front matter from the body. */
function splitFrontMatter(text: string): { front: string; body: string } | undefined {
  // Only CR and CRLF, which YAML also reads as line breaks. NEL and the Unicode separators are
  // plain characters to YAML, so they're handled where text is rendered (see `lines`).
  const normalised = text.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalised);
  return match === null ? undefined : { front: match[1] ?? "", body: (match[2] ?? "").trim() };
}

/** Everything a markdown reader may take as a line break, including ones a YAML escape makes. */
const LINE_BREAK = /\r\n?|\n|[\u0085\u2028\u2029]/;

/** Indents every line, so an example renders as a code block whatever it contains. */
function indent(text: string, by: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => (line === "" ? "" : `${by}${line}`))
    .join("\n");
}

/** Collapses whitespace and line breaks of every kind, so a field stays on its one line. */
function oneLine(text: string): string {
  return text.replace(/[\s\u0085]+/g, " ").trim();
}

/**
 * Renders a pack for the prompt: rules grouped by category, in the order they first appear.
 * The title, description and rules are kept on one line, and examples are indented as code.
 * A repo pack's body is indented as code too: for a trusted pack it's guidance in markdown,
 * but repo text mustn't add any structure (headings of any kind, lists, quotes) of its own.
 */
function renderPack(
  title: string,
  description: string | undefined,
  body: string,
  rules: readonly PackRule[],
  source: RulePackSource,
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
          `- ${rule.id} (default severity: ${rule.severity}): ${oneLine(rule.rule)}\n  Example:\n\n${indent(rule.example, "      ")}`,
      ),
    ].join("\n\n"),
  );
  const intro = description === undefined ? undefined : oneLine(description);
  const guidance =
    source === "repo" && body !== "" ? indent(body, "    ") : body.split(LINE_BREAK).join("\n");
  return [`# ${oneLine(title)}`, intro, guidance, ...sections]
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
    throw new RulePackError(
      `Rule pack ${name} is invalid: ${issues.join("; ")}.`,
      issues.map((issue) => `Rule pack ${name} is invalid: ${issue}.`),
    );
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
    text: renderPack(parsed.title, parsed.description, parsed.body, parsed.rules, source),
  };
}

/**
 * Parses and checks one pack file. `name` is what the pack is called in messages and its id;
 * for built-in and private packs, the id its front matter must have.
 */
export function parseRulePack(
  text: string,
  name: string,
  source: RulePackSource,
  floors?: ReadonlyMap<string, number>,
): RulePack {
  const parsed = parsePackFile(text, name, source);
  if (source === "repo") {
    const soft = softRules(parsed.rules, floors ?? severityFloors([]));
    if (soft.length > 0) {
      const reasons = soft.map((entry) => entry.reason);
      throw new RulePackError(
        `Rule pack ${name} was rejected: ${reasons.join("; ")}.`,
        reasons.map((reason) => `Rule pack ${name} was rejected: ${reason}.`),
      );
    }
  }
  return toPack(parsed, name, source);
}

/** The rules softer than their category's floor, with the reason for each. */
function softRules(
  rules: readonly PackRule[],
  floors: ReadonlyMap<string, number>,
): { rule: PackRule; reason: string }[] {
  return rules.flatMap((rule) => {
    const floor = floors.get(rule.category);
    if (floor === undefined || severityRank(rule.severity) <= floor) return [];
    return [
      {
        rule,
        reason: `rule ${rule.id} is ${rule.severity}, but a repo rule in ${rule.category} can't be softer than ${SEVERITIES[floor]}`,
      },
    ];
  });
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
  // Only the built-in ids are listed: the deployment's private pack names stay private.
  throw new UnknownRulePackError(
    `Unknown rule pack "${id}". The built-in packs are: ${index.builtin.join(", ")}.`,
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
  /**
   * Entries, or rules, from the repo's config that couldn't be used, and why. Meant for the
   * repo's owners, so they never name private packs. The review goes on without them.
   */
  problems: string[];
  /** Problems with the deployment's own packs, for the operator's log only. */
  warnings: string[];
}

/** A regular file directly in the repo's `rules` folder. */
const RULES_ENTRY = /^(100644|100755) blob ([0-9a-f]{40,64})\t(rules\/[^/]+)$/;
/** A file name a pack id allows. */
const RULES_PACK_PATH = /^rules\/[a-z0-9][a-z0-9-]*\.md$/;
/** Files read at most, so a `rules` folder full of packs can't make the review fetch them all. */
const MAX_REPO_PACK_READS = 2 * REPO_RULE_PACK_LIMITS.maxFiles;

/** A short reason for the operator's log. Git errors never carry the token. */
function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

/** Code-unit order, as convention files are sorted, so it doesn't depend on the locale. */
function byCodeUnit(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/**
 * Reads blobs in one batch. If that fails (a huge file, a failed fetch), one at a time, so only
 * the file at fault is missing from the result. Failures are logged, not thrown.
 */
async function readBatch(
  repo: Pick<Repo, "readBlobs">,
  batch: readonly { path: string; blob: string }[],
  warnings: string[],
): Promise<Map<string, Buffer>> {
  try {
    return await repo.readBlobs(batch.map((entry) => entry.blob));
  } catch (error) {
    warnings.push(`Reading repo rule packs together failed, so one at a time: ${reasonOf(error)}`);
  }
  const blobs = new Map<string, Buffer>();
  for (const entry of batch) {
    try {
      const one = (await repo.readBlobs([entry.blob])).get(entry.blob);
      if (one !== undefined) blobs.set(entry.blob, one);
    } catch (error) {
      warnings.push(`Reading ./${entry.path} failed: ${reasonOf(error)}`);
    }
  }
  return blobs;
}

/**
 * Reads the repo packs `wanted` names (paths, or `rules/*.md`) at `sha`, within the limits.
 * Only files named like a pack are fetched; the listing has no sizes, which would make a
 * partial clone fetch every blob in the folder. A file over the per-file limit is left out
 * whole and doesn't count towards the total.
 */
async function readRepoPacks(
  repo: Pick<Repo, "git" | "readBlobs">,
  sha: string,
  wanted: ReadonlySet<string>,
  problems: string[],
  warnings: string[],
): Promise<{ path: string; text: string }[]> {
  const listing = await repo.git(["ls-tree", "-z", sha, "--", "rules/"]);
  const all = wanted.has("rules/*.md");
  const entries: { path: string; blob: string }[] = [];
  for (const line of listing.split("\0")) {
    const [, , blob, path] = RULES_ENTRY.exec(line) ?? [];
    if (blob === undefined || path === undefined) continue;
    const readme = /^rules\/readme\.md$/i.test(path);
    if (RULES_PACK_PATH.test(path)) {
      // The glob skips a README; naming one explicitly reads it.
      if (wanted.has(path) || (all && !readme)) entries.push({ path, blob });
    } else if (all && !readme && /\.md$/i.test(path)) {
      problems.push(
        `./${path} was left out: name repo rule packs with lowercase letters, digits and hyphens, ending in .md.`,
      );
    }
  }
  entries.sort((a, b) => byCodeUnit(a.path, b.path));
  for (const path of wanted) {
    if (path !== "rules/*.md" && !entries.some((entry) => entry.path === path)) {
      problems.push(`./${path} isn't in the base branch, or isn't a regular file.`);
    }
  }

  const { maxBytes, maxFiles, maxTotalBytes } = REPO_RULE_PACK_LIMITS;
  const chosen: { path: string; text: string }[] = [];
  let total = 0;
  let next = 0;
  while (next < entries.length && chosen.length < maxFiles && next < MAX_REPO_PACK_READS) {
    // Only as many as can still be used, so a folder of valid packs is read in one batch.
    const batch = entries.slice(
      next,
      Math.min(next + maxFiles - chosen.length, MAX_REPO_PACK_READS),
    );
    next += batch.length;
    const blobs = await readBatch(repo, batch, warnings);
    for (const entry of batch) {
      const content = blobs.get(entry.blob);
      if (content === undefined) {
        problems.push(`./${entry.path} couldn't be read, so it was left out.`);
      } else if (content.length > maxBytes) {
        problems.push(
          `./${entry.path} was left out: a repo rule pack can be at most ${maxBytes / 1024} KiB.`,
        );
      } else if (total + content.length > maxTotalBytes) {
        problems.push(
          `./${entry.path} was left out: repo rule packs are limited to ${maxTotalBytes / 1024} KiB in all.`,
        );
      } else {
        chosen.push({ path: entry.path, text: content.toString("utf8") });
        total += content.length;
      }
    }
  }
  for (const entry of entries.slice(next)) {
    problems.push(
      chosen.length >= maxFiles
        ? `./${entry.path} was left out: repo rule packs are limited to ${maxFiles} files.`
        : `./${entry.path} was left out: only the first ${MAX_REPO_PACK_READS} pack files in rules/ are read.`,
    );
  }
  return chosen;
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
  const warnings: string[] = [];
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
    warnings.push(
      `The private rule pack "${id}" has a built-in pack's id, so the built-in one is used.`,
    );
  }
  // Loaded together; problems are reported in the list's order, not the order loads finish.
  const loaded = await Promise.all(
    named.map((id) =>
      loadIndexed(id, index).catch((error: unknown) => {
        if (error instanceof RulePackError) return error;
        throw error;
      }),
    ),
  );
  const packs: RulePack[] = [];
  for (const [i, result] of loaded.entries()) {
    if (!(result instanceof RulePackError)) packs.push(result);
    else if (i < MANDATORY_RULE_PACKS.length) warnings.push(result.message);
    else if (result instanceof UnknownRulePackError) problems.push(result.message);
    else {
      // A broken built-in or private pack is the deployment's to fix, and its details stay in
      // the log. The repo only learns that a pack it asked for couldn't be used.
      warnings.push(result.message);
      problems.push(`Rule pack "${named[i]}" couldn't be loaded; ask whoever runs LGTMoose.`);
    }
  }

  if (repoPaths.size > 0) {
    if (options.repo === undefined || options.baseSha === undefined) {
      problems.push("Repo rule packs need the repository; they were left out.");
      return { packs, problems, warnings };
    }
    const floors = severityFloors(packs);
    for (const file of await readRepoPacks(
      options.repo,
      options.baseSha,
      repoPaths,
      problems,
      warnings,
    )) {
      const name = `./${file.path}`;
      let parsed: ParsedPack;
      try {
        parsed = parsePackFile(file.text, name, "repo");
      } catch (error) {
        if (!(error instanceof RulePackError)) throw error;
        problems.push(...error.issues);
        continue;
      }
      const soft = softRules(parsed.rules, floors);
      problems.push(...soft.map((entry) => `${name}: ${entry.reason}, so that rule was left out.`));
      const rules = parsed.rules.filter((rule) => !soft.some((entry) => entry.rule === rule));
      if (rules.length > 0) packs.push(toPack({ ...parsed, rules }, name, "repo"));
    }
  }
  return { packs, problems, warnings };
}
