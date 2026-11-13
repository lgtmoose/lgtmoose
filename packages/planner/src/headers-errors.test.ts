import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDiff } from "@lgtmoose/git";
import { describe, expect, it, vi } from "vitest";

// Every open fails as if the process were out of file descriptors.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async () => {
      throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    },
  };
});

const { readHeaders } = await import("./headers.js");

describe("readHeaders errors", () => {
  it("rejects on errors other than a missing file, instead of giving no header", async () => {
    const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
    const dir = await actual.mkdtemp(join(tmpdir(), "lgtmoose-headers-"));
    try {
      await actual.writeFile(join(dir, "a.ts"), "x");
      const file: FileDiff = {
        path: "a.ts",
        status: "modified",
        oldBlob: "a".repeat(40),
        newBlob: "b".repeat(40),
        submodule: false,
        moved: false,
        mechanical: false,
        binary: false,
        hunks: [],
      };
      const repo = { dir, readBlobs: async () => new Map<string, Buffer>() };
      await expect(readHeaders(repo, [file])).rejects.toThrow("EMFILE");
    } finally {
      await actual.rm(dir, { recursive: true, force: true });
    }
  });
});
