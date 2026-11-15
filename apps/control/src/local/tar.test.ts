import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTar, writeTar } from "./tar.js";

const exec = promisify(execFile);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgtmoose-tar-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tar", () => {
  it("writes archives that tar extracts, with owners and modes", async () => {
    const archive = writeTar([
      { name: "io", mode: 0o700, uid: 10001, gid: 10001 },
      { name: "io/input.json", body: Buffer.from('{"a":1}'), mode: 0o600, uid: 10001, gid: 10001 },
      { name: "io/empty", body: Buffer.alloc(0), mode: 0o600, uid: 10001, gid: 10001 },
    ]);
    await writeFile(join(dir, "a.tar"), archive);
    const { stdout } = await exec("tar", ["-tvf", join(dir, "a.tar"), "--numeric-owner"]);
    expect(stdout).toMatch(/drwx------ 10001\/10001 .* io\//);
    expect(stdout).toMatch(/-rw------- 10001\/10001 .* io\/input.json/);
    await exec("tar", ["-xf", join(dir, "a.tar"), "-C", dir]);
    expect(await readFile(join(dir, "io/input.json"), "utf8")).toBe('{"a":1}');
  });

  it("reads regular files back, and skips links", async () => {
    await writeFile(join(dir, "out.json"), "x".repeat(700));
    await exec("ln", ["-s", "/etc/passwd", join(dir, "link")]);
    await exec("tar", ["-cf", join(dir, "b.tar"), "-C", dir, "out.json", "link"]);
    const files = readTar(await readFile(join(dir, "b.tar")), 10_000);
    expect([...files.keys()]).toEqual(["out.json"]);
    expect(files.get("out.json")?.toString()).toBe("x".repeat(700));
    expect(() =>
      readTar(
        writeTar([{ name: "big", body: Buffer.alloc(2000), mode: 0o600, uid: 0, gid: 0 }]),
        1000,
      ),
    ).toThrow(/over 1000 bytes/);
  });
});
