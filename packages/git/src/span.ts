/** A line's text with its whitespace collapsed: how lines are compared across versions. */
export function normaliseLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** A file's lines (`[0]` is line 1), without the empty element after a final newline. */
export function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * A finding's lines, to find them again where its commit is gone: the cited lines (start to
 * line), normalised, without blank lines, widened with neighbouring non-blank lines while
 * they're too short to say much (fewer than `MIN_TOKENS` tokens, such as a lone `}`), and which
 * of them is the finding's own line.
 */
export interface LineSpan {
  lines: string[];
  /** Index in `lines` of the finding's line. */
  at: number;
}

const MIN_TOKENS = 4;
/** How far a short span is widened, each side, in non-blank lines. */
const MAX_WIDEN = 2;
const TOKEN = /[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu;

const tokens = (text: string) => text.match(TOKEN)?.length ?? 0;

/**
 * The span of `line` (from `start`) in a file's `lines` (`[0]` is line 1). Undefined when the
 * line isn't in the file or is blank: there's nothing to find it by.
 */
export function lineSpan(
  lines: readonly string[],
  line: number,
  start: number = line,
): LineSpan | undefined {
  const text = (n: number) => normaliseLine(lines[n - 1] ?? "");
  if (line < 1 || line > lines.length || text(line) === "") return undefined;
  let from = Math.max(1, Math.min(start, line));
  let to = Math.max(start, line);
  const nonBlank = (a: number, b: number) => {
    const out: number[] = [];
    for (let n = a; n <= b; n++) if (text(n) !== "") out.push(n);
    return out;
  };
  const step = (n: number, by: -1 | 1) => {
    for (let next = n + by; next >= 1 && next <= lines.length; next += by) {
      if (text(next) !== "") return next;
    }
    return n;
  };
  for (
    let widen = 0;
    widen < MAX_WIDEN &&
    nonBlank(from, to).reduce((sum, n) => sum + tokens(text(n)), 0) < MIN_TOKENS;
    widen++
  ) {
    from = step(from, -1);
    to = step(to, 1);
  }
  const kept = nonBlank(from, to);
  return { lines: kept.map(text), at: kept.indexOf(line) };
}

/**
 * Where `span` is in a file's `lines`: its lines as consecutive non-blank lines there, giving
 * the line its finding is on, of those `allowed` takes. The nearest to `near`; on a tie, the
 * earlier. Undefined: not there. Every place in the file is tried, however far.
 */
export function findSpan(
  lines: readonly string[],
  span: LineSpan,
  near: number,
  allowed: (line: number) => boolean = () => true,
): number | undefined {
  const at: number[] = [];
  const texts: string[] = [];
  for (const [i, raw] of lines.entries()) {
    const text = normaliseLine(raw);
    if (text === "") continue;
    at.push(i + 1);
    texts.push(text);
  }
  let best: number | undefined;
  for (let i = 0; i + span.lines.length <= texts.length; i++) {
    if (!span.lines.every((text, k) => texts[i + k] === text)) continue;
    const line = at[i + span.at];
    if (line === undefined || !allowed(line)) continue;
    const distance = Math.abs(line - near);
    const bestDistance = best === undefined ? Infinity : Math.abs(best - near);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && line < best)
    ) {
      best = line;
    }
  }
  return best;
}

/** A span as stored (`findings.line_text`). */
export function encodeSpan(span: LineSpan): string {
  return JSON.stringify(span);
}

/** A stored span, or undefined when it isn't one. */
export function decodeSpan(text: string | undefined): LineSpan | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "lines" in value &&
      "at" in value &&
      Array.isArray(value.lines) &&
      value.lines.every((line) => typeof line === "string") &&
      typeof value.at === "number" &&
      Number.isInteger(value.at) &&
      value.at >= 0 &&
      value.at < value.lines.length
    ) {
      return { lines: value.lines as string[], at: value.at };
    }
  } catch {
    // Not a span.
  }
  return undefined;
}
