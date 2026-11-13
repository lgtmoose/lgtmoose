export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  /** Line number in the old file, for context and deleted lines. */
  oldLine?: number;
  /** Line number in the new file, for context and added lines. */
  newLine?: number;
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the second `@@`, usually the enclosing function. */
  section: string;
  lines: DiffLine[];
}

export interface FilePatch {
  oldPath: string | undefined;
  newPath: string | undefined;
  binary: boolean;
  hunks: Hunk[];
}

/** Undoes git's C-style quoting of unusual paths ("a/tab\there" and octal UTF-8 bytes). */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, raw.lastIndexOf('"'));
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `--- a/x` / `+++ b/x` path, or undefined for /dev/null. */
function headerPath(rest: string): string | undefined {
  const path = unquotePath(rest.replace(/\t.*$/, ""));
  if (path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//, "");
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parses `git diff` output made with `--no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/`.
 * Paths come from the `rename from/to` and `---`/`+++` headers, never from the `diff --git` line,
 * which is ambiguous when a path contains spaces.
 */
export function parsePatch(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  let file: FilePatch | undefined;
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // The paths here are a fallback for patches with no ---/+++ (mode-only or empty files).
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { oldPath: match?.[1], newPath: match?.[2], binary: false, hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (hunk) {
      const kind = line[0];
      if (kind === " " || kind === "+" || kind === "-") {
        const body = line.slice(1);
        if (kind === " ")
          hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: body });
        else if (kind === "+") hunk.lines.push({ kind: "add", newLine: newLine++, text: body });
        else hunk.lines.push({ kind: "del", oldLine: oldLine++, text: body });
        continue;
      }
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      hunk = undefined;
    }
    const range = HUNK.exec(line);
    if (range) {
      oldLine = Number(range[1]);
      newLine = Number(range[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: range[2] === undefined ? 1 : Number(range[2]),
        newStart: newLine,
        newLines: range[4] === undefined ? 1 : Number(range[4]),
        section: range[5] ?? "",
        lines: [],
      };
      file.hunks.push(hunk);
    } else if (line.startsWith("rename from ")) {
      file.oldPath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      file.newPath = unquotePath(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      file.oldPath = unquotePath(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      file.newPath = unquotePath(line.slice("copy to ".length));
    } else if (line.startsWith("new file mode")) {
      file.oldPath = undefined;
    } else if (line.startsWith("deleted file mode")) {
      file.newPath = undefined;
    } else if (line.startsWith("--- ")) {
      file.oldPath = headerPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      file.newPath = headerPath(line.slice(4));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
  }
  return files;
}
