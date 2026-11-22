import { LEARNING_KINDS, type LearningKind, type LearningProposal } from "@lgtmoose/learnings";

/**
 * `@lgtmoose` commands in PR comments: finding them in a comment body and parsing each one.
 * Pure: no GitHub and no database. The body is a person's comment, so it's untrusted text;
 * nothing here acts on it, it only says which command was asked for.
 *
 * A command is a mention of the App's bot (`@<slug>` or `@<slug>[bot]`), or of one of the
 * deployment's `commandAliases` (NIC-1119), outside code (fenced blocks and inline spans) and
 * quotes (`>` lines), followed by the command on the same line. Which handle was used never
 * changes what a command may do: that depends on who wrote the comment.
 */

/** The name the docs use for the bot. A deployment's App may be called something else. */
export const DOCS_HANDLE = "lgtmoose";

/** The most commands one comment can carry; later mentions are ignored. */
export const MAX_COMMANDS = 5;

export type Command =
  | { name: "help" }
  | { name: "review"; full: boolean }
  | { name: "pause" }
  | { name: "resume" }
  /** `explain`: in a finding's thread, or with `path:line`. */
  | { name: "explain"; at?: { path: string; line: number } }
  | { name: "learn"; text: string }
  | { name: "forget"; id: string }
  /** `approve <id>`: makes a pending learning active. */
  | { name: "approve"; id: string }
  | { name: "learnings" }
  | { name: "ignore" }
  /** In a declined finding's thread: learn not to raise findings like it here (NIC-1081). */
  | { name: "remember" }
  /** Anything else: answered with the help text. */
  | { name: "unknown"; word: string };

/** Blanks out fenced code blocks, inline code spans and quoted lines, keeping line breaks. */
export function withoutCodeAndQuotes(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== undefined) {
      // Inside a fence until a line of the same kind, at least as long.
      if (
        opener?.[1] !== undefined &&
        opener[1][0] === fence[0] &&
        opener[1].length >= fence.length
      ) {
        fence = undefined;
      }
      out.push("");
      continue;
    }
    if (opener?.[1] !== undefined) {
      fence = opener[1];
      out.push("");
      continue;
    }
    if (/^\s*>/.test(line)) {
      out.push("");
      continue;
    }
    // Inline code: a run of backticks up to the same run.
    out.push(line.replace(/(`+)[^`]*?\1/g, " "));
  }
  return out.join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/** The handles a comment may address: the App's slug and the aliases, without duplicates. */
function handlesOf(handles: string | readonly string[]): string[] {
  const list = typeof handles === "string" ? [handles] : handles;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const handle = raw.trim();
    const key = handle.toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

/**
 * The text after each mention of the bot, one entry per mention, up to `MAX_COMMANDS`. A
 * mention is `@<handle>` or `@<handle>[bot]`, for the App's slug or an alias, and not part of
 * a longer name or an email address.
 */
export function mentions(body: string, handles: string | readonly string[]): string[] {
  const names = handlesOf(handles);
  if (names.length === 0) return [];
  const text = withoutCodeAndQuotes(body);
  // Longest first, so `@lgtmoose-acme` is never read as `@lgtmoose` followed by `-acme`.
  const alternation = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(
    `(?<![\\w@.-])@(?:${alternation})(?:\\[bot\\])?(?![\\w-])([^\\n]*)`,
    "gi",
  );
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    found.push((match[1] ?? "").trim());
    if (found.length === MAX_COMMANDS) break;
  }
  return found;
}

/** A learning's ID as `learnings` lists it (a UUID); the store says whether it exists. */
const LEARNING_ID = /^[0-9a-z][0-9a-z-]{0,63}$/i;

/** One command from the text after a mention. Empty text is `help`. */
export function parseCommand(text: string): Command {
  const trimmed = text.trim().replace(/^[,:]\s*/, "");
  const learn = /^learn(?:\s*:\s*|\s+)([\s\S]+)$/i.exec(trimmed);
  if (learn?.[1] !== undefined && learn[1].trim() !== "") {
    return { name: "learn", text: learn[1].trim() };
  }
  const words = trimmed.split(/\s+/).filter((word) => word !== "");
  // Keywords match without trailing punctuation: "ignore, it's fine" and "review!" count.
  const [first = "", second = "", third] = words.map((word) =>
    word.toLowerCase().replace(/[,.;:!?]+$/, ""),
  );
  switch (first) {
    case "":
    case "help":
      return { name: "help" };
    case "review":
      return { name: "review", full: false };
    case "full":
      return second === "review"
        ? { name: "review", full: true }
        : { name: "unknown", word: first };
    case "pause":
      return { name: "pause" };
    case "resume":
      return { name: "resume" };
    case "learnings":
      return { name: "learnings" };
    case "ignore":
      return { name: "ignore" };
    case "remember":
      return { name: "remember" };
    case "forget":
    case "approve": {
      const id = words[1] ?? "";
      return LEARNING_ID.test(id) && third === undefined
        ? { name: first, id: id.toLowerCase() }
        : { name: "unknown", word: first };
    }
    case "explain": {
      const where = words[1];
      if (where === undefined) return { name: "explain" };
      const at = /^(.+):(\d{1,7})$/.exec(where);
      const line = at?.[2] === undefined ? Number.NaN : Number(at[2]);
      return at?.[1] !== undefined && line > 0
        ? { name: "explain", at: { path: at[1].replace(/^\.\//, ""), line } }
        : { name: "unknown", word: "explain" };
    }
    default:
      return { name: "unknown", word: first };
  }
}

/**
 * Every command in a comment body, in order. `handles` is the App's slug, or the slug followed
 * by the deployment's aliases.
 */
export function parseCommands(body: string, handles: string | readonly string[]): Command[] {
  return mentions(body, handles).map(parseCommand);
}

/**
 * Whether a comment that has no command for this App looks meant for it (NIC-1119): `@lgtmoose`,
 * the handle the docs use, followed by a whole, well-formed command, where this App is called
 * something else and `lgtmoose` isn't one of its aliases. Its author gets one hint per PR with
 * the real handle.
 */
export function addressesDocsHandle(body: string, handles: readonly string[]): boolean {
  if (handlesOf(handles).some((handle) => handle.toLowerCase() === DOCS_HANDLE)) return false;
  return mentions(body, DOCS_HANDLE).some(isWholeCommand);
}

/**
 * Whether the text after a mention is a whole command, as `parseCommand` reads it, with nothing
 * else on the line: "review", "full review", "approve <id>", "explain src/a.ts:3", "learn: <text>".
 * One trailing `.`, `!` or `?` is allowed, also after a space. "Thanks @lgtmoose!" (nothing),
 * "@lgtmoose help me see why…" and "cc @lgtmoose: review of this is in #12" (more words than the
 * command takes) aren't. Nor is "learn from this": `parseCommand` reads `learn` with a space as
 * the command too, but in a sentence only the `learn:` form says it's one.
 */
export function isWholeCommand(text: string): boolean {
  const trimmed = text
    .trim()
    .replace(/^[,:]\s*/, "")
    .replace(/[.!?]$/, "")
    .trim();
  if (trimmed === "") return false;
  const command = parseCommand(trimmed);
  // `learn:` takes the rest of the line as its text; it needs the colon and some text.
  if (command.name === "learn") return /^learn\s*:\s*\S/i.test(trimmed);
  const words = trimmed.split(/\s+/);
  switch (command.name) {
    case "unknown":
      return false;
    case "review":
      return words.length === (command.full ? 2 : 1);
    case "forget":
    case "approve":
      return words.length === 2;
    case "explain":
      return words.length === (command.at === undefined ? 1 : 2);
    default:
      return words.length === 1;
  }
}

/** The one-time hint for a comment `addressesDocsHandle` matched: the handle that works here. */
export function handleHint(slug: string): string {
  return `Commands here use \`@${slug}\`, not \`@${DOCS_HANDLE}\`. For example, \`@${slug} review\`; \`@${slug} help\` lists them all.`;
}

/**
 * A `learn:` text as a proposal. By default a repo-wide `convention`. Leading tags narrow or
 * widen it, each at most once: `[path <glob>]`, `[org]`, `[kind <kind>]` and
 * `[category <name>]`. Unknown tags are left in the text. The policy (`proposeLearning`)
 * validates the result and decides whether it's active; who proposed it comes from GitHub.
 */
export function learningProposal(text: string): LearningProposal {
  let rest = text.trim();
  let kind: LearningKind = "convention";
  let category: string | undefined;
  let scope: LearningProposal["scope"] = { level: "repo" };
  for (;;) {
    const tag = /^\[(\w+)(?:\s+([^\]]+))?\]\s*/.exec(rest);
    if (tag === null) break;
    const [whole, name = "", value] = tag;
    const key = name.toLowerCase();
    const arg = value?.trim();
    if (key === "org" && arg === undefined) {
      scope = { level: "org" };
    } else if (key === "path" && arg !== undefined && arg !== "") {
      scope = { level: "path", pathGlob: arg.replace(/^\.\//, "") };
    } else if (
      key === "kind" &&
      arg !== undefined &&
      (LEARNING_KINDS as readonly string[]).includes(arg.toLowerCase())
    ) {
      kind = arg.toLowerCase() as LearningKind;
    } else if (key === "category" && arg !== undefined) {
      category = arg.toLowerCase();
    } else {
      break;
    }
    rest = rest.slice(whole.length);
  }
  return { kind, text: rest, ...(category === undefined ? {} : { category }), scope };
}

/** The help text, for `help` and unknown commands. */
export function helpText(slug: string): string {
  const at = `@${slug}`;
  return [
    `Commands for ${at}, one per line:`,
    "",
    "| Command | What it does |",
    "| --- | --- |",
    `| \`${at} review\` | Reviews the latest commit, if it hasn't been reviewed. |`,
    `| \`${at} full review\` | Reviews the whole PR again, ignoring earlier reviews. |`,
    `| \`${at} pause\` | Stops automatic reviews on this PR (needs write access). |`,
    `| \`${at} resume\` | Starts automatic reviews again (needs write access). |`,
    `| \`${at} explain\` | In a finding's thread, or \`explain path:line\`: explains that finding. For the PR's author or someone with write access, a model answers in a later run. |`,
    `| \`${at} ignore\` | In a finding's thread: declines it. Blocking findings need someone with write access other than the PR's author. |`,
    `| \`${at} remember\` | In a declined finding's thread: learns not to raise findings like it in this repo. Applied at once with write access, otherwise pending. Never for protected categories. |`,
    `| \`${at} learn: <text>\` | Proposes a learning for this repo. Tags: \`[path <glob>]\`, \`[org]\`, \`[kind <kind>]\`, \`[category <name>]\`. Applied at once with write access, otherwise pending. |`,
    `| \`${at} learnings\` | Lists the learnings that apply to this PR. |`,
    `| \`${at} approve <id>\` | Makes a pending learning active (needs write access, or an org owner for org-wide ones). |`,
    `| \`${at} forget <id>\` | Retires a learning (needs write access, or an org owner for org-wide ones). |`,
    `| \`${at} help\` | Shows this list. |`,
  ].join("\n");
}
