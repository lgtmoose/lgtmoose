import { describe, expect, it } from "vitest";
import { classifyCursorFailure } from "./cursor/result.js";
import { classifyFailure } from "./limits.js";
import { HeadTail } from "./headtail.js";
import { runProcess } from "./process.js";
import { statusesIn } from "./status.js";

describe("HeadTail", () => {
  it("keeps short text whole", () => {
    const kept = new HeadTail(4, 6);
    kept.add("abc");
    kept.add("defg");
    expect(kept.text()).toBe("abcdefg");
  });

  it("keeps the start and the end of long text, and says how much it left out", () => {
    const kept = new HeadTail(4, 6);
    for (const chunk of ["head", "-middle-middle-", "tail!!"]) kept.add(chunk);
    expect(kept.text()).toBe("head\n… 15 characters left out …\n" + "tail!!");
  });

  it("cuts at a line break when one is near", () => {
    const kept = new HeadTail(10, 10);
    kept.add("line one\nline two is long\n…middle…\nthe end\n");
    // The head stops after "line one\n"; the tail starts after the break nearest its cut.
    expect(kept.text()).toMatch(/^line one\n\n… \d+ characters left out …\nthe end\n$/);
  });

  it("never splits a character outside the basic plane", () => {
    const emoji = "😀"; // two UTF-16 code units
    const head = new HeadTail(3, 4);
    head.add(`ab${emoji}${"x".repeat(20)}`);
    const text = head.text();
    expect(text.startsWith(`ab${emoji}`)).toBe(true);
    expect(text).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );

    const tail = new HeadTail(2, 3);
    tail.add(`${"x".repeat(20)}${emoji}yy`);
    expect(tail.text().endsWith(`${emoji}yy`) || tail.text().endsWith("yy")).toBe(true);
    expect(tail.text()).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
  });

  it("is idempotent: a kept text isn't cut again", () => {
    const long = `${"a".repeat(100 * 1024)}\n${"b".repeat(100 * 1024)}`;
    const once = HeadTail.of(long);
    expect(HeadTail.of(once)).toBe(once);
  });

  it("stays linear over many small chunks", () => {
    const kept = new HeadTail();
    const started = performance.now();
    for (let i = 0; i < 100_000; i++) kept.add("0123456789");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(kept.text().length).toBeLessThan(65 * 1024);
  });
});

describe("runProcess stderr", () => {
  it("keeps the final error line after chatty output", async () => {
    const script = [
      "for (let i = 0; i < 20000; i++) process.stderr.write('noise line ' + i + '\\n');",
      "process.stderr.write('Error: [unauthenticated] token revoked\\n');",
    ].join("");
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      input: "",
      timeoutMs: 20_000,
      killGraceMs: 100,
      maxOutputBytes: 1024,
    });
    expect(result.stderr).toContain("noise line 0\n");
    expect(result.stderr).toContain("characters left out");
    expect(result.stderr.trimEnd().endsWith("token revoked")).toBe(true);
    expect(classifyCursorFailure(result.stderr)?.kind).toBe("auth");
  });
});

describe("classifiers on long messages", () => {
  const filler = "x".repeat(200 * 1024);

  it("read the start and the end", () => {
    expect(classifyFailure(`HTTP 429\n${filler}`)?.kind).toBe("rate_limit");
    expect(classifyFailure(`${filler}\n{"status":401}`)?.kind).toBe("auth");
    expect([...statusesIn(`${filler}\nHTTP 429`)]).toEqual([429]);
  });

  it("don't read the middle", () => {
    expect(classifyFailure(`${filler}HTTP 429\n${filler}`)).toBeUndefined();
  });
});
