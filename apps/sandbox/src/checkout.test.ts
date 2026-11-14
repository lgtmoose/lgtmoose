import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropSymlinks } from "./checkout.js";

let root: string;
let checkout: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lgtmoose-checkout-"));
  checkout = join(root, "checkout");
  await mkdir(join(checkout, "docs", "deep"), { recursive: true });
  await writeFile(join(checkout, "README.md"), "hi");
  await writeFile(join(root, "secret"), "outside");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("dropSymlinks", () => {
  it("drops every link: outside, inside, into config, to a directory and dangling", async () => {
    await mkdir(join(checkout, "config", "hooks"), { recursive: true });
    await symlink("/proc/self/environ", join(checkout, "docs", "env"));
    await symlink("../../secret", join(checkout, "docs", "up"));
    await symlink("../README.md", join(checkout, "docs", "readme"));
    await symlink("config", join(checkout, ".cursor"));
    await symlink("missing", join(checkout, "gone"));
    expect(await dropSymlinks(checkout)).toEqual([
      ".cursor",
      "docs/env",
      "docs/readme",
      "docs/up",
      "gone",
    ]);
    expect(await exists(join(checkout, "docs", "readme"))).toBe(false);
    // Files and the targets stay.
    expect(await exists(join(checkout, "README.md"))).toBe(true);
    expect(await exists(join(checkout, "config", "hooks"))).toBe(true);
    expect(await exists(join(root, "secret"))).toBe(true);
  });

  it("doesn't walk through a directory link", async () => {
    await mkdir(join(root, "outside"));
    await symlink("../outside-target", join(root, "outside", "inner"));
    await symlink(join(root, "outside"), join(checkout, "docs", "dir"));
    expect(await dropSymlinks(checkout)).toEqual(["docs/dir"]);
    expect(await exists(join(root, "outside", "inner"))).toBe(true);
  });

  it.skipIf(process.platform !== "linux")(
    "removes links under names that aren't valid UTF-8, and walks such directories",
    async () => {
      const dir = Buffer.concat([Buffer.from(join(checkout, "d")), Buffer.from([0xff])]);
      await mkdir(dir);
      const link = Buffer.concat([dir, Buffer.from("/l"), Buffer.from([0xfe])]);
      await symlink("/proc/self/environ", link);
      await writeFile(Buffer.concat([dir, Buffer.from("/f")]), "x");
      const dropped = await dropSymlinks(checkout);
      expect(dropped).toHaveLength(1);
      await expect(lstat(link)).rejects.toThrow(/ENOENT/);
      await expect(lstat(Buffer.concat([dir, Buffer.from("/f")]))).resolves.toBeDefined();
    },
  );

  it("leaves a checkout without links alone", async () => {
    expect(await dropSymlinks(checkout)).toEqual([]);
  });
});
