import type { FileDiff } from "@lgtmoose/git";
import { describe, expect, it } from "vitest";
import { readHeaders } from "./headers.js";

const sha = (c: string) => c.repeat(40);

function diff(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    status: "modified",
    oldBlob: sha("a"),
    newBlob: sha("b"),
    submodule: false,
    moved: false,
    mechanical: false,
    binary: false,
    hunks: [],
    ...overrides,
  };
}

function fakeRepo(contents: Record<string, string>) {
  const calls: { shas: string[]; local: string[] }[] = [];
  return {
    calls,
    fullCheckout: true,
    readBlobs: async (shas: Iterable<string>, options?: { local?: Iterable<string> }) => {
      const list = [...shas];
      calls.push({ shas: list, local: [...(options?.local ?? [])] });
      return new Map(list.map((s) => [s, Buffer.from(contents[s] ?? "")]));
    },
  };
}

describe("readHeaders", () => {
  it("reads heads first, then only the bases of marked heads", async () => {
    const repo = fakeRepo({
      [sha("b")]: `// @generated\n${"x".repeat(5000)}`,
      [sha("a")]: "// @generated",
      [sha("d")]: "plain",
    });
    const files = [
      diff("api.ts"),
      diff("plain.ts", { oldBlob: sha("c"), newBlob: sha("d") }),
      diff("pnpm-lock.yaml", { oldBlob: sha("e"), newBlob: sha("f") }),
      diff("logo.png", { binary: true, oldBlob: sha("1"), newBlob: sha("2") }),
      diff("libs/sub", { submodule: true, oldBlob: sha("3"), newBlob: sha("4") }),
      diff("new.ts", { status: "added", oldBlob: undefined, newBlob: sha("5") }),
    ];
    const headers = await readHeaders(repo, files);
    expect(repo.calls).toEqual([
      { shas: [sha("b"), sha("d")], local: [sha("b"), sha("d")] },
      { shas: [sha("a")], local: [] },
    ]);
    expect(headers.get(sha("b"))).toHaveLength(2048);
    expect(headers.get(sha("a"))).toBe("// @generated");
  });

  it("reads nothing when no file needs a header", async () => {
    const repo = fakeRepo({});
    expect((await readHeaders(repo, [diff("docs/a.md")], ["docs/**"])).size).toBe(0);
    expect(repo.calls).toEqual([]);
  });
});
