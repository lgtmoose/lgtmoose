import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneAtSha, githubCloneUrl } from "./clone.js";
import { runGit } from "./exec.js";
import { FixtureRepo } from "./testing/fixture.js";

let fixture: FixtureRepo;
beforeEach(async () => {
  fixture = await FixtureRepo.create();
});
afterEach(async () => {
  await fixture.destroy();
});

describe("cloneAtSha", () => {
  it("checks out head as a partial clone, fetching file contents only as they're read", async () => {
    await fixture.write({ "a.txt": "one\n", "b.txt": "two\n" });
    const head = await fixture.commit("first");
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: head,
    });

    expect((await repo.git(["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await readFile(join(repo.dir, "a.txt"), "utf8")).toBe("one\n");
    expect((await repo.git(["config", "remote.origin.partialclonefilter"])).trim()).toBe(
      "blob:none",
    );
  });

  it("can skip the working tree and write only the files asked for", async () => {
    await fixture.write({ "a.txt": "one\n", "dir/b c.txt": "two\n", ":magic": "three\n" });
    const head = await fixture.commit("first");
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: head,
      checkout: "none",
    });
    await expect(readFile(join(repo.dir, "a.txt"), "utf8")).rejects.toThrow();
    await repo.checkoutPaths(["dir/b c.txt", ":magic"]);
    expect(await readFile(join(repo.dir, "dir/b c.txt"), "utf8")).toBe("two\n");
    expect(await readFile(join(repo.dir, ":magic"), "utf8")).toBe("three\n");
    await expect(readFile(join(repo.dir, "a.txt"), "utf8")).rejects.toThrow();
  });

  it("reads many blobs at once", async () => {
    await fixture.write({ "a.txt": "one\n", "b.bin": Buffer.from([0, 10, 255]) });
    const head = await fixture.commit("first");
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: head,
      checkout: "none",
    });
    const [a, b] = (await repo.git(["rev-parse", `${head}:a.txt`, `${head}:b.bin`]))
      .trim()
      .split("\n");
    const blobs = await repo.readBlobs([a ?? "", b ?? ""]);
    expect(blobs.get(a ?? "")?.toString()).toBe("one\n");
    expect([...(blobs.get(b ?? "") ?? [])]).toEqual([0, 10, 255]);
  });

  it("fetches other commits by SHA, even ones no branch points at", async () => {
    const first = await fixture.commit("first");
    await fixture.write({ "a.txt": "changed\n" });
    const second = await fixture.commit("second");
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: first,
      otherShas: [second],
    });
    expect(await repo.hasCommit(second)).toBe(true);
  });

  it("skips a commit the remote no longer has instead of failing", async () => {
    const head = await fixture.commit("first");
    const gone = "f".repeat(40);
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: head,
      otherShas: [gone],
    });
    expect(await repo.hasCommit(gone)).toBe(false);
  });

  it("never writes the token to disk or into errors", async () => {
    const head = await fixture.commit("first");
    const token = "ghs_FAKEINSTALLATIONTOKEN123";
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: head,
      token,
    });
    const config = await readFile(join(repo.dir, ".git", "config"), "utf8");
    expect(config).not.toContain(token);
    expect(config).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));

    const error = await repo.git(["log", "--no-such-flag"]).then(
      () => new Error("expected a failure"),
      (e: unknown) => e as Error,
    );
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain("x-access-token");
  });

  it("refuses credentials in the URL and anything but a full SHA", async () => {
    const head = await fixture.commit("first");
    const dir = await fixture.cloneDir();
    await expect(
      cloneAtSha({ url: "https://x-access-token:abc@github.com/o/r.git", dir, headSha: head }),
    ).rejects.toThrow("must not contain credentials");
    await expect(cloneAtSha({ url: fixture.url, dir, headSha: "main" })).rejects.toThrow(
      "Not a full commit SHA",
    );
    await expect(
      cloneAtSha({ url: fixture.url, dir, headSha: head, otherShas: ["--upload-pack=evil"] }),
    ).rejects.toThrow("Not a full commit SHA");
  });

  it("names the clone URL for a GitHub repository", () => {
    expect(githubCloneUrl("acme", "web app")).toBe("https://github.com/acme/web%20app.git");
  });

  it("ignores the machine's global git config", async () => {
    const head = await fixture.commit("first");
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: head,
    });
    const { stdout } = await runGit(repo.dir, ["config", "--show-origin", "--list"]);
    expect(stdout).not.toMatch(/^file:\/(etc|root|home)/m);
  });
});
