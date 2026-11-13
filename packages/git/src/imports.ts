/**
 * Finds the lines a file's import statements take up, so a change that only adds, removes or
 * reorders imports can be told apart from a change to behaviour. Covers JavaScript/TypeScript,
 * Python, Go, Java/Kotlin/Scala, C#, Rust and C/C++; other languages have no import lines, so
 * their changes are never mechanical.
 */

type Language = "js" | "python" | "go" | "jvm" | "csharp" | "rust" | "c";

const EXTENSIONS: Record<string, Language> = {
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  py: "python",
  pyi: "python",
  go: "go",
  java: "jvm",
  kt: "jvm",
  kts: "jvm",
  scala: "jvm",
  cs: "csharp",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
};

export function languageOf(path: string): Language | undefined {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext === undefined ? undefined : EXTENSIONS[ext];
}

/**
 * Whether an import statement starts on this line, and whether it ends there too. `closer` is
 * the text that ends it when that differs from the language's usual rule.
 */
function startsImport(
  language: Language,
  line: string,
): { complete: boolean; closer?: string } | undefined {
  const text = line.trim();
  switch (language) {
    case "js": {
      const isImport =
        /^import(\s|\{|\*|["'])/.test(text) ||
        /^export\s+(type\s+)?(\*|\{)/.test(text) ||
        /^(const|let|var)\s+[\w${}\s,:]+=\s*require\(/.test(text);
      if (!isImport) return undefined;
      // `export { a }` without `from` re-exports local names: still declaration-only.
      return {
        complete:
          /(\bfrom\s*["'][^"']*["']|require\([^)]*\)|^import\s*["'][^"']*["'])\s*;?\s*$/.test(
            text,
          ) || /^export\s+(type\s+)?\{[^}]*\}\s*;?\s*$/.test(text),
      };
    }
    case "python":
      if (!/^(import\s|from\s+\S+\s+import\b)/.test(text)) return undefined;
      if (text.includes("(") && !text.includes(")")) return { complete: false, closer: ")" };
      return { complete: !text.endsWith("\\") };
    case "go":
      if (!/^import\b/.test(text)) return undefined;
      return { complete: !/^import\s*\($/.test(text) };
    case "jvm":
      if (!/^import\s/.test(text)) return undefined;
      return { complete: true };
    case "csharp":
      if (!/^(global\s+)?using\s+[\w.]+(\s*=\s*[\w.<>]+)?\s*;$/.test(text)) return undefined;
      return { complete: true };
    case "rust":
      if (!/^(pub(\([\w:]+\))?\s+)?use\s/.test(text) && !/^extern\s+crate\s/.test(text))
        return undefined;
      return { complete: text.endsWith(";") };
    case "c":
      if (!/^#\s*(include|import)\b/.test(text)) return undefined;
      return { complete: true };
  }
}

function endsImport(language: Language, line: string): boolean {
  const text = line.trim();
  switch (language) {
    case "js":
      return /\bfrom\s*["'][^"']*["']\s*;?\s*$/.test(text) || /^\}\s*;?\s*$/.test(text);
    case "python":
      return !text.endsWith("\\");
    case "go":
      return text === ")";
    case "rust":
      return text.endsWith(";");
    default:
      return true;
  }
}

/** 1-based line numbers that belong to import statements. Empty for unknown languages. */
export function importLines(path: string, content: string): Set<number> {
  const language = languageOf(path);
  const lines = new Set<number>();
  if (language === undefined) return lines;
  let open = false;
  let closer: string | undefined;
  content.split("\n").forEach((line, index) => {
    const number = index + 1;
    if (open) {
      lines.add(number);
      const ended = closer === undefined ? endsImport(language, line) : line.includes(closer);
      if (ended) open = false;
      return;
    }
    const start = startsImport(language, line);
    if (start) {
      lines.add(number);
      open = !start.complete;
      closer = start.closer;
    }
  });
  return lines;
}
