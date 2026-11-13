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

function fakeRepo(contents: Record<string, string>) {
  const calls: string[][] = [];
  return {
    calls,
    dir,
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
    expect(headers.get(sha("b"))).toHaveLength(2048);
    expect(headers.get(sha("d"))).toBe("plain");
    expect(headers.has(sha("f"))).toBe(false);
    expect(headers.get(sha("a"))).toBe("// @generated");
  });

  it("gives no header for a file that isn't checked out", async () => {
    const headers = await readHeaders(fakeRepo({}), [diff("missing/a.ts")]);
    expect(headers.size).toBe(0);
  });

  it("reads many files without running out of file descriptors", async () => {
    const files = await Promise.all(
      Array.from({ length: 300 }, async (_, i) => {
        await writeFile(join(dir, `f${i}.ts`), "x");
        return diff(`f${i}.ts`, { newBlob: i.toString(16).padStart(40, "0") });
      }),
    );
    expect((await readHeaders(fakeRepo({}), files)).size).toBe(300);
  });

  it("reads nothing when no file needs a header", async () => {
    const repo = fakeRepo({});
    expect((await readHeaders(repo, [diff("docs/a.md")], ["docs/**"])).size).toBe(0);
    expect(repo.calls).toEqual([]);
  });
});
