import type { FileDiff } from "@lgtmoose/git";
import { describe, expect, it } from "vitest";
import { readHeaders } from "./headers.js";

function diff(overrides: Partial<FileDiff>): FileDiff {
  return {
    path: "a.ts",
    status: "modified",
    oldBlob: "a".repeat(40),
    newBlob: "b".repeat(40),
    submodule: false,
    moved: false,
    mechanical: false,
    binary: false,
    hunks: [],
    ...overrides,
  };
}

describe("readHeaders", () => {
  it("reads both sides of text files in one call, keeping head's blobs local", async () => {
    const calls: { shas: string[]; local: string[] }[] = [];
    const repo = {
      fullCheckout: true,
      readBlobs: async (shas: Iterable<string>, options?: { local?: Iterable<string> }) => {
        calls.push({ shas: [...shas], local: [...(options?.local ?? [])] });
        return new Map([
          ["a".repeat(40), Buffer.from("base")],
          ["b".repeat(40), Buffer.from("x".repeat(5000))],
        ]);
      },
    };
    const files = [
      diff({}),
      diff({ path: "logo.png", binary: true, oldBlob: "c".repeat(40), newBlob: "d".repeat(40) }),
      diff({ path: "libs/sub", submodule: true, oldBlob: "e".repeat(40), newBlob: "f".repeat(40) }),
    ];
    const headers = await readHeaders(repo, files);
    expect(calls).toEqual([{ shas: ["b".repeat(40), "a".repeat(40)], local: ["b".repeat(40)] }]);
    expect(headers.get("a".repeat(40))).toBe("base");
    expect(headers.get("b".repeat(40))).toHaveLength(2048);
  });
});
