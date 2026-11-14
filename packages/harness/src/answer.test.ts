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
    expect(parseAnswer('```js\n{"a":1}\n```')).toEqual({
      ok: false,
      error: "The answer wasn't valid JSON.",
    });
  });

  it("accepts CRLF line ends", () => {
    expect(parseAnswer('```json\r\n{"a":1}\r\n```\r\n')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseAnswer('Here:\r\n```\r\n{"a":2}\r\n```')).toEqual({ ok: true, value: { a: 2 } });
  });

  it("reports a missing or invalid answer", () => {
    expect(parseAnswer(undefined).ok).toBe(false);
    expect(parseAnswer("  ").ok).toBe(false);
    expect(parseAnswer("Here you go: {a: 1}")).toEqual({
      ok: false,
      error: "The answer wasn't valid JSON.",
    });
  });
});
