/**
 * Markdown helpers for text that goes into prompts under our own headings. They read fences and
 * headings the way CommonMark does, so the structure they see is the structure a reader sees.
 */

interface Fence {
  char: string;
  length: number;
}

/** A fence line: up to three spaces of indent; a backtick fence's info can't hold a backtick. */
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})(.*)$/;

/**
 * Maps each line outside fences (fence lines and their contents are kept as they are), and
 * says which fence, if any, the text leaves open.
 */
function mapOutsideFences(
  text: string,
  map: (line: string) => string,
): { text: string; open: Fence | undefined } {
  let fence: Fence | undefined;
  const lines = text.split("\n").map((line) => {
    const marker = FENCE.exec(line);
    if (marker !== null) {
      const run = marker[1] ?? "";
      const char = run.charAt(0);
      if (fence === undefined) {
        fence = { char, length: run.length };
        return line;
      }
      // Closed only by the same character, at least as many times, with nothing after it.
      if (char === fence.char && run.length >= fence.length && (marker[2] ?? "").trim() === "") {
        fence = undefined;
        return line;
      }
    }
    return fence === undefined ? map(line) : line;
  });
  return { text: lines.join("\n"), open: fence };
}

/** Moves markdown headings outside fences down two levels, so they nest under ours. */
export function demoteHeadings(text: string): string {
  // ATX headings may be indented up to three spaces, with a space or tab after the hashes.
  return mapOutsideFences(text, (line) => line.replace(/^( {0,3})(#{1,4})(?=[ \t]|$)/, "$1##$2"))
    .text;
}

/** Closes a fence the text leaves open, so it can't swallow what follows it. */
export function closeOpenFence(text: string): string {
  const { open } = mapOutsideFences(text, (line) => line);
  return open === undefined ? text : `${text}\n${open.char.repeat(open.length)}`;
}
