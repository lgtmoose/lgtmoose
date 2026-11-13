import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDiff } from "@lgtmoose/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgtmoose-headers-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeRepo(contents: Record<string, string>, fullCheckout = true) {
  const calls: string[][] = [];
  const checkedOut: string[][] = [];
  return {
    calls,
    checkedOut,
    dir,
    fullCheckout,
    checkoutPaths: async (paths: readonly string[]) => {
      checkedOut.push([...paths]);
    },
    readBlobs: async (shas: Iterable<string>) => {
      const list = [...shas];
      calls.push(list);
      return new Map(list.map((s) => [s, Buffer.from(contents[s] ?? "")]));
    },
  };
}

describe("readHeaders", () => {
  it("reads heads' first bytes from the checkout, then only the bases of marked heads", async () => {
    await writeFile(join(dir, "api.ts"), `// @generated\n${"x".repeat(5000)}`);
    await writeFile(join(dir, "plain.ts"), "plain");
    await symlink("/etc/hostname", join(dir, "link.ts"));
    const repo = fakeRepo({ [sha("a")]: "// @generated" });
    const files = [
      diff("api.ts"),
      diff("plain.ts", { oldBlob: sha("c"), newBlob: sha("d") }),
      diff("link.ts", { oldBlob: sha("e"), newBlob: sha("f") }),
      diff("pnpm-lock.yaml", { oldBlob: sha("1"), newBlob: sha("2") }),
      diff("logo.png", { binary: true, oldBlob: sha("3"), newBlob: sha("4") }),
      diff("new.ts", { status: "added", oldBlob: undefined, newBlob: sha("5") }),
    ];
    const headers = await readHeaders(repo, files);
    expect(repo.calls).toEqual([[sha("a")]]);
    expect(repo.checkedOut).toEqual([]);
    expect(headers.get(sha("b"))).toHaveLength(2048);
    expect(headers.get(sha("d"))).toBe("plain");
    expect(headers.has(sha("f"))).toBe(false);
    expect(headers.get(sha("a"))).toBe("// @generated");
  });

  it("checks the paths out first without a full checkout", async () => {
    const repo = fakeRepo({}, false);
    await readHeaders(repo, [diff("a.ts")]);
    expect(repo.checkedOut).toEqual([["a.ts"]]);
  });

  it("reads nothing when no file needs a header", async () => {
    const repo = fakeRepo({}, false);
    expect((await readHeaders(repo, [diff("docs/a.md")], ["docs/**"])).size).toBe(0);
    expect(repo.calls).toEqual([]);
    expect(repo.checkedOut).toEqual([]);
  });
});
