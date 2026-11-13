/**
 * What the model may do inside Claude Code. Three layers, each enough on its own for the cases
 * it covers:
 *
 * 1. `--tools` makes only Read, Grep, Glob and Bash exist. No Write, Edit, WebFetch, WebSearch
 *    or subagents. `--restricted` confines the file tools to the checkout.
 * 2. Permission rules in `dontAsk` mode: the allow list below runs, deny rules win over it, and
 *    anything else that would need approval is refused.
 * 3. A PreToolUse hook (`guardScript`) that refuses every Bash command except a plain
 *    `git diff`, `git log` or `git show`. It also stops Claude Code's built-in read-only
 *    commands (`cat`, `ls`, `git status` and so on), which run without any allow rule.
 */

/** Built-in tools that exist in the session. */
export const TOOLS = ["Read", "Grep", "Glob", "Bash"];

/** Git subcommands the model may run. */
export const GIT_SUBCOMMANDS = ["diff", "log", "show"];

/** Tool calls that run without approval. */
export const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  ...GIT_SUBCOMMANDS.flatMap((sub) => [`Bash(git ${sub} *)`, `Bash(git --no-pager ${sub} *)`]),
];

/**
 * Refused even when an allow rule matches. `--output` writes a file, `--no-index` compares files
 * outside the repository, and `--ext-diff` and `--textconv` run programs.
 */
export const DISALLOWED_TOOLS = [
  "Bash(git *--output*)",
  "Bash(git *--no-index*)",
  "Bash(git *--ext-diff*)",
  "Bash(git *--textconv*)",
  "Bash(env *)",
  "Bash(printenv *)",
  "WebFetch",
  "WebSearch",
];

/**
 * Whether a Bash command is a plain `git diff`, `git log` or `git show`. No pipes, redirects,
 * substitutions, variables, globs or other shell syntax; quoted words are fine.
 *
 * It must stay self-contained (no imports, no outside names): `guardScript` embeds its source.
 */
export function isAllowedGitCommand(command: string): boolean {
  const subcommands = ["diff", "log", "show"];
  const refusedOptions = ["--output", "--no-index", "--ext-diff", "--textconv"];
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = "";
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = "";
      else if ("$`\\!".includes(ch)) return false;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    // Shell syntax: separators, pipes, redirects, substitution, globs, escapes, comments.
    if (";&|<>()`$\\*?[]{}!#\n\r".includes(ch)) return false;
    // A ~ at the start of a word or after = or : can expand to a home directory. Elsewhere,
    // as in HEAD~1, it's literal.
    if (ch === "~" && (!inWord || word.endsWith("=") || word.endsWith(":"))) return false;
    word += ch;
    inWord = true;
  }
  if (quote) return false;
  if (inWord) words.push(word);

  if (words[0] !== "git") return false;
  const sub = words[1] === "--no-pager" ? words[2] : words[1];
  if (sub === undefined || !subcommands.includes(sub)) return false;
  return !words.some((w) => refusedOptions.some((option) => w.startsWith(option)));
}

const REFUSAL =
  "Refused: only plain `git diff`, `git log` and `git show` commands may run, without pipes, " +
  "redirects or other shell syntax. Use the Read, Grep and Glob tools for files.";

/** The PreToolUse hook script, for Node. It exits 2 to block a Bash call. */
export function guardScript(): string {
  return [
    `const isAllowedGitCommand = ${isAllowedGitCommand.toString()};`,
    `let input = "";`,
    `process.stdin.on("data", (chunk) => (input += chunk));`,
    `process.stdin.on("end", () => {`,
    `  let command;`,
    `  try {`,
    `    const event = JSON.parse(input);`,
    `    command = event.tool_name === "Bash" ? event.tool_input?.command : "";`,
    `  } catch {}`,
    `  if (command === "") process.exit(0);`,
    `  if (typeof command === "string" && isAllowedGitCommand(command)) process.exit(0);`,
    `  process.stderr.write(${JSON.stringify(REFUSAL)});`,
    `  process.exit(2);`,
    `});`,
    ``,
  ].join("\n");
}

/**
 * Settings passed with `--settings`. With `--restricted`, these and managed settings are the only
 * ones loaded: the checkout's `.claude/` settings and hooks are ignored. Keep to keys the pinned
 * version knows, because print mode silently ignores a settings file that fails validation. The
 * tests check that the rules here are also passed as flags, so they hold either way.
 */
export function sessionSettings(guardCommand: string): Record<string, unknown> {
  return {
    permissions: {
      allow: ALLOWED_TOOLS,
      deny: DISALLOWED_TOOLS,
      // Bash's built-in read-only commands are refused outside the checkout too.
      blockReadsOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: "disable",
    },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guardCommand }] }],
    },
  };
}
