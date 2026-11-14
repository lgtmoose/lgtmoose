import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropEscapingSymlinks } from "./checkout.js";

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

describe("dropEscapingSymlinks", () => {
  it("drops links that lead outside the checkout, absolute or relative", async () => {
    await symlink("/proc/self/environ", join(checkout, "docs", "env"));
    await symlink("../../secret", join(checkout, "docs", "up"));
    await symlink(root, join(checkout, "docs", "dir"));
    expect(await dropEscapingSymlinks(checkout)).toEqual(["docs/dir", "docs/env", "docs/up"]);
    expect(await exists(join(checkout, "docs", "env"))).toBe(false);
    expect(await exists(join(root, "secret"))).toBe(true);
  });

  it("keeps links that stay inside", async () => {
    await symlink("../README.md", join(checkout, "docs", "readme"));
    await symlink("deep", join(checkout, "docs", "alias"));
    expect(await dropEscapingSymlinks(checkout)).toEqual([]);
    expect(await readlink(join(checkout, "docs", "readme"))).toBe("../README.md");
  });

  it("catches a chain whose `..` climbs out through another link", async () => {
    // `top` points at the checkout root, so `top/../secret` is outside, though it reads inside.
    await symlink("../..", join(checkout, "docs", "deep", "top"));
    await symlink("deep/top/../secret", join(checkout, "docs", "sneaky"));
    expect(await dropEscapingSymlinks(checkout)).toEqual(["docs/sneaky"]);
  });

  it("keeps links into a directory whose name only starts with dots", async () => {
    await mkdir(join(checkout, "..data"));
    await writeFile(join(checkout, "..data", "a"), "x");
    await symlink("..data/a", join(checkout, "link"));
    expect(await dropEscapingSymlinks(checkout)).toEqual([]);
  });

  it("drops dangling links", async () => {
    await symlink("missing", join(checkout, "gone"));
    expect(await dropEscapingSymlinks(checkout)).toEqual(["gone"]);
  });
});
