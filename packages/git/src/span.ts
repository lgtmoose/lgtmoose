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
 * A finding's lines, to find them again where its commit is gone: its own lines (start to
 * line), normalised, without blank lines, with neighbouring non-blank lines around them while
 * its own are too short to say much (fewer than `MIN_TOKENS` tokens, such as a lone `}`). The
 * finding is found by its own lines; the neighbours only choose between several such places.
 */
export interface LineSpan {
  lines: string[];
  /** Indexes in `lines` of the finding's own first and last lines. */
  from: number;
  to: number;
  /** Index in `lines` of the finding's line. */
  at: number;
}

const MIN_TOKENS = 4;
/** How far a short span is widened, each side, in non-blank lines. */
const MAX_WIDEN = 2;
const TOKEN = /[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu;

const tokens = (texts: readonly string[]) =>
  texts.reduce((sum, text) => sum + (text.match(TOKEN)?.length ?? 0), 0);

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
  const first = Math.max(1, Math.min(start, line));
  const last = Math.max(start, line);
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
  const own = nonBlank(first, last);
  let from = first;
  let to = last;
  for (
    let widen = 0;
    widen < MAX_WIDEN && tokens(nonBlank(from, to).map(text)) < MIN_TOKENS;
    widen++
  ) {
    from = step(from, -1);
    to = step(to, 1);
  }
  const kept = nonBlank(from, to);
  return {
    lines: kept.map(text),
    from: kept.indexOf(own[0] ?? line),
    to: kept.indexOf(own.at(-1) ?? line),
    at: kept.indexOf(line),
  };
}

/**
 * Where `span`'s finding is in a file's `lines`: a place where its own lines are consecutive
 * non-blank lines, giving a line `allowed` takes. One such place: there. Several: those whose
 * neighbours match too, the nearest to `near` (the earlier on a tie); if none's neighbours
 * match, the nearest, unless its own lines are too short to tell places apart (a lone `}`),
 * when it's not guessed. Undefined: not found. Every place in the file is tried, however far.
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
  const own = span.lines.slice(span.from, span.to + 1);
  const found: { line: number; whole: boolean }[] = [];
  for (let i = 0; i + own.length <= texts.length; i++) {
    if (!own.every((text, k) => texts[i + k] === text)) continue;
    const line = at[i + span.at - span.from];
    if (line === undefined || !allowed(line)) continue;
    const start = i - span.from;
    const whole =
      start >= 0 &&
      start + span.lines.length <= texts.length &&
      span.lines.every((text, k) => texts[start + k] === text);
    found.push({ line, whole });
  }
  if (found.length <= 1) return found[0]?.line;
  const whole = found.filter((candidate) => candidate.whole);
  if (whole.length === 0 && tokens(own) < MIN_TOKENS) return undefined;
  const choices = whole.length > 0 ? whole : found;
  return choices.reduce((best, candidate) => {
    const distance = Math.abs(candidate.line - near);
    const bestDistance = Math.abs(best.line - near);
    return distance < bestDistance || (distance === bestDistance && candidate.line < best.line)
      ? candidate
      : best;
  }).line;
}

/** A span as stored (`findings.line_text`). */
export function encodeSpan(span: LineSpan): string {
  return JSON.stringify(span);
}

const isIndex = (value: unknown, length: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length;

/** A stored span, or undefined when it isn't one. */
export function decodeSpan(text: string | undefined): LineSpan | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const { lines, from, to, at } = value as Record<string, unknown>;
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      return undefined;
    }
    const n = lines.length;
    if (!isIndex(from, n) || !isIndex(to, n) || !isIndex(at, n)) return undefined;
    if (from > at || at > to) return undefined;
    return { lines: lines as string[], from, to, at };
  } catch {
    return undefined;
  }
}
