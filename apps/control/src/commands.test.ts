import { describe, expect, it } from "vitest";
import {
  helpText,
  learningProposal,
  MAX_COMMANDS,
  mentions,
  parseCommand,
  parseCommands,
  withoutCodeAndQuotes,
} from "./commands.js";

describe("mentions", () => {
  it("finds the bot's mentions and the text after each", () => {
    expect(mentions("Thanks!\n@lgtmoose review\nand @LGTMoose[bot] pause", "lgtmoose")).toEqual([
      "review",
      "pause",
    ]);
  });

  it("ignores mentions in fenced code, inline code and quotes", () => {
    const body = [
      "```",
      "@lgtmoose pause",
      "```",
      "~~~md",
      "@lgtmoose forget x",
      "~~~",
      "> @lgtmoose full review",
      "Run `@lgtmoose review` to review.",
      "  > @lgtmoose learn: quoted",
    ].join("\n");
    expect(mentions(body, "lgtmoose")).toEqual([]);
  });

  it("ignores longer names and email addresses", () => {
    expect(mentions("@lgtmoose-dev review, ops@lgtmoose review", "lgtmoose")).toEqual([]);
  });

  it("stops at the most commands one comment can carry", () => {
    const body = Array.from({ length: 8 }, () => "@lgtmoose help").join("\n");
    expect(mentions(body, "lgtmoose")).toHaveLength(MAX_COMMANDS);
  });

  it("escapes the slug for the pattern", () => {
    expect(mentions("@a.b review @axb pause", "a.b")).toEqual(["review @axb pause"]);
  });
});

describe("withoutCodeAndQuotes", () => {
  it("keeps the text outside a closed fence", () => {
    expect(withoutCodeAndQuotes("````\n```\n````\nafter").split("\n")).toEqual([
      "",
      "",
      "",
      "after",
    ]);
  });
});

describe("parseCommand", () => {
  it("parses each command", () => {
    expect(parseCommand("")).toEqual({ name: "help" });
    expect(parseCommand("help")).toEqual({ name: "help" });
    expect(parseCommand("Review please")).toEqual({ name: "review", full: false });
    expect(parseCommand("full review")).toEqual({ name: "review", full: true });
    expect(parseCommand("pause")).toEqual({ name: "pause" });
    expect(parseCommand("resume")).toEqual({ name: "resume" });
    expect(parseCommand("learnings")).toEqual({ name: "learnings" });
    expect(parseCommand("ignore, this is fine")).toEqual({ name: "ignore" });
    expect(parseCommand("explain")).toEqual({ name: "explain" });
    expect(parseCommand("explain ./src/a.ts:12")).toEqual({
      name: "explain",
      at: { path: "src/a.ts", line: 12 },
    });
    expect(parseCommand("learn: Use the shared logger.")).toEqual({
      name: "learn",
      text: "Use the shared logger.",
    });
    expect(parseCommand("learn use zod")).toEqual({ name: "learn", text: "use zod" });
    const id = "0d6f6a2e-5b1c-4f43-9a8b-1c2d3e4f5a6b";
    expect(parseCommand(`forget ${id.toUpperCase()}`)).toEqual({ name: "forget", id });
    expect(parseCommand(`approve ${id}`)).toEqual({ name: "approve", id });
  });

  it("takes anything else as unknown", () => {
    expect(parseCommand("deploy")).toEqual({ name: "unknown", word: "deploy" });
    expect(parseCommand("full speed")).toEqual({ name: "unknown", word: "full" });
    expect(parseCommand("forget")).toEqual({ name: "unknown", word: "forget" });
    expect(parseCommand("forget a b")).toEqual({ name: "unknown", word: "forget" });
    expect(parseCommand("approve")).toEqual({ name: "unknown", word: "approve" });
    expect(parseCommand("approve this please")).toEqual({ name: "unknown", word: "approve" });
    expect(parseCommand("explain here")).toEqual({ name: "unknown", word: "explain" });
    expect(parseCommand("learn:")).toEqual({ name: "unknown", word: "learn" });
  });

  it("reads a comment's commands in order", () => {
    expect(parseCommands("@bot pause\n@bot learnings", "bot")).toEqual([
      { name: "pause" },
      { name: "learnings" },
    ]);
  });
});

describe("learningProposal", () => {
  it("defaults to a repo-wide convention", () => {
    expect(learningProposal("Prefer the shared logger.")).toEqual({
      kind: "convention",
      text: "Prefer the shared logger.",
      scope: { level: "repo" },
    });
  });

  it("reads leading tags for scope, kind and category", () => {
    expect(
      learningProposal("[path ./legacy/**] [kind accepted_pattern] [category style] Old code."),
    ).toEqual({
      kind: "accepted_pattern",
      category: "style",
      text: "Old code.",
      scope: { level: "path", pathGlob: "legacy/**" },
    });
    expect(learningProposal("[org] Use pnpm.")).toMatchObject({ scope: { level: "org" } });
  });

  it("leaves an unknown tag, or an unknown kind, in the text", () => {
    expect(learningProposal("[todo] fix")).toMatchObject({ text: "[todo] fix" });
    expect(learningProposal("[kind nonsense] x")).toMatchObject({
      kind: "convention",
      text: "[kind nonsense] x",
    });
  });
});

describe("helpText", () => {
  it("names every command with the bot's handle", () => {
    const text = helpText("moose");
    for (const command of [
      "review",
      "full review",
      "pause",
      "resume",
      "explain",
      "ignore",
      "learn:",
      "learnings",
      "approve",
      "forget",
      "help",
    ]) {
      expect(text).toContain(`@moose ${command}`);
    }
  });
});
