/**
 * The part of a long text the harness keeps: its start (what a CLI said first) and its end (where
 * its final error is), so chatty output in between can't push the cause out. Used for stderr as
 * it streams in, and by the failure classifiers for any long message.
 */

const HEAD = 16 * 1024;
const TAIL = 48 * 1024;
/** How far a cut may move to land on a line break. */
const LINE_SLACK = 512;
/** Room the note about what was left out takes, so a kept text is never cut again. */
const NOTE_ROOM = 64;

/** Moves a cut off the middle of a surrogate pair, so no character is split. */
function onCodePoint(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const code = text.charCodeAt(cut);
  return code >= 0xdc00 && code <= 0xdfff ? cut + 1 : cut;
}

/** The end of the head: at the last line break before `size`, when one is near. */
function headCut(text: string, size: number): number {
  const lineEnd = text.lastIndexOf("\n", size - 1);
  if (lineEnd >= 0 && size - (lineEnd + 1) <= LINE_SLACK) return lineEnd + 1;
  return onCodePoint(text, size);
}

/** The start of the tail: just after the first line break after `from`, when one is near. */
function tailCut(text: string, from: number): number {
  const lineEnd = text.indexOf("\n", from);
  if (lineEnd >= 0 && lineEnd + 1 - from <= LINE_SLACK) return lineEnd + 1;
  return onCodePoint(text, from);
}

/** Collects a stream's text, keeping its first `headSize` and last `tailSize` characters. */
export class HeadTail {
  private head = "";
  private headDone = false;
  private tail = "";
  private dropped = 0;

  constructor(
    private readonly headSize = HEAD,
    private readonly tailSize = TAIL,
  ) {}

  add(text: string): void {
    let rest = text;
    if (!this.headDone) {
      const joined = this.head + rest;
      if (joined.length <= this.headSize) {
        this.head = joined;
        return;
      }
      const cut = headCut(joined, this.headSize);
      this.head = joined.slice(0, cut);
      rest = joined.slice(cut);
      this.headDone = true;
    }
    this.tail += rest;
    // Trimmed in batches, so collecting stays linear.
    if (this.tail.length > 2 * this.tailSize + LINE_SLACK) this.trim();
  }

  text(): string {
    this.trim();
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n… ${this.dropped} characters left out …\n${this.tail}`;
  }

  /**
   * A text cut down the same way. Idempotent: a text no longer than what's kept, the note
   * included, comes back as it is, so cutting twice is harmless.
   */
  static of(text: string): string {
    if (text.length <= HEAD + TAIL + NOTE_ROOM) return text;
    const kept = new HeadTail();
    kept.add(text);
    return kept.text();
  }

  private trim(): void {
    if (this.tail.length <= this.tailSize) return;
    const cut = tailCut(this.tail, this.tail.length - this.tailSize);
    this.dropped += cut;
    this.tail = this.tail.slice(cut);
  }
}
