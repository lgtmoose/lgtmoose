import { describe, expect, it } from "vitest";
import { parseAnswer } from "./answer.js";

describe("parseAnswer", () => {
  it("parses bare JSON and a whole-message fence", () => {
    expect(parseAnswer('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseAnswer('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("takes the last fence when there's prose around it", () => {
    const answer = 'Draft:\n```json\n{"a":0}\n```\nFinal:\n```\n{"a":2}\n```\nDone.';
    expect(parseAnswer(answer)).toEqual({ ok: true, value: { a: 2 } });
  });

  it("pairs fences in order, so a diff block before the JSON isn't mixed into it", () => {
    const answer = 'See:\n```diff\n- a\n+ b\n```\nAnswer:\n```json\n{"a":3}\n```\n';
    expect(parseAnswer(answer)).toEqual({ ok: true, value: { a: 3 } });
  });

  it("skips fences tagged with another language, as the Codex parser did", () => {
    expect(parseAnswer('```js\n{"a":1}\n```').ok).toBe(false);
  });

  it("accepts CRLF line ends", () => {
    expect(parseAnswer('```json\r\n{"a":1}\r\n```\r\n')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseAnswer('Here:\r\n```\r\n{"a":2}\r\n```')).toEqual({ ok: true, value: { a: 2 } });
  });

  it("reports a missing or invalid answer", () => {
    expect(parseAnswer(undefined)).toEqual({ ok: false, error: "There was no answer." });
    expect(parseAnswer("  ").ok).toBe(false);
    expect(parseAnswer("Here you go: {a: 1}").ok).toBe(false);
  });

  it("says why the JSON didn't parse, from the last fence, briefly", () => {
    const fenced = parseAnswer('Answer:\n```json\n{"a": 1,}\n```');
    expect(fenced.ok).toBe(false);
    if (fenced.ok) return;
    expect(fenced.error).toMatch(/^The answer wasn't valid JSON: \S/);
    expect(fenced.error).not.toContain("Answer:");
    const long = parseAnswer(`x${"y".repeat(5000)}`);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.length).toBeLessThan(260);
  });
});
