import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkTree } from "./tree.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lgtmoose-tree-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Linux filesystems take any bytes in a name; macOS's don't. */
const anyBytes = process.platform === "linux";

describe("walkTree", () => {
  it("reports every entry, without following links", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "f.ts"), "");
    await symlink("a", join(root, "link"));
    const seen: string[] = [];
    await walkTree(root, ({ relText }) => {
      seen.push(relText);
      return undefined;
    });
    expect(seen.sort()).toEqual(["a", "a/b", "a/b/f.ts", "link"]);
  });

  it.skipIf(!anyBytes)(
    "walks names that aren't valid UTF-8, with paths that reach them",
    async () => {
      const name = Buffer.from([0x66, 0xff, 0xfe, 0x2e, 0x74, 0x73]); // "f\xff\xfe.ts"
      const dir = Buffer.concat([
        Buffer.from(join(root, "d")),
        Buffer.from("/"),
        Buffer.from([0xc3]),
      ]);
      await mkdir(dir, { recursive: true });
      await writeFile(Buffer.concat([dir, Buffer.from("/"), name]), "x");
      const paths: Buffer[] = [];
      await walkTree(root, ({ path, entry }) => {
        if (entry.isFile()) paths.push(path);
        return undefined;
      });
      expect(paths).toHaveLength(1);
      expect(paths[0]?.subarray(-name.length).equals(name)).toBe(true);
    },
  );

  it("skips a directory that vanishes before it's walked", async () => {
    await mkdir(join(root, "gone"));
    await writeFile(join(root, "gone", "f"), "");
    const seen: string[] = [];
    // The directory is reported, then removed before the walk opens it.
    await walkTree(root, async ({ relText }) => {
      seen.push(relText);
      if (relText === "gone") await rm(join(root, "gone"), { recursive: true });
      return undefined;
    });
    expect(seen).toEqual(["gone"]);
  });

  it("still fails when the root itself is missing", async () => {
    await expect(walkTree(join(root, "missing"), () => undefined)).rejects.toThrow(/ENOENT/);
  });
});
