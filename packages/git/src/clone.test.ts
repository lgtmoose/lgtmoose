import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneAtSha, githubCloneUrl, isMissingObjectError } from "./clone.js";
import { reviewDiff } from "./diff.js";
import { serveOverHttp } from "./testing/http-server.js";
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

  it("recognises a missing commit, and only that, as missing", async () => {
    const head = await fixture.commit("first");
    const dir = await fixture.cloneDir();
    const repo = await cloneAtSha({ url: fixture.url, dir, headSha: head });
    const missing = await repo.git(["fetch", "origin", "f".repeat(40)]).catch((e: unknown) => e);
    expect(isMissingObjectError(missing)).toBe(true);
    expect(isMissingObjectError(new Error("not our ref"))).toBe(false);
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

  it("still fetches the other commits when one of them is gone", async () => {
    const head = await fixture.commit("first");
    // Commits off head's history, so only a fetch brings them.
    await fixture.checkout("side", true);
    await fixture.write({ "a.txt": "one\n" });
    const one = await fixture.commit("one");
    await fixture.write({ "a.txt": "two\n" });
    const two = await fixture.commit("two");
    const gone = "f".repeat(40);
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: head,
      otherShas: [one, gone],
    });
    expect(await repo.hasCommit(one)).toBe(true);
    expect(await repo.hasCommit(gone)).toBe(false);
    await repo.fetchCommits([two, gone]);
    expect(await repo.hasCommit(two)).toBe(true);
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

  it("sends the token on every fetch over HTTP: clone, prefetch and checkoutPaths", async () => {
    await fixture.write({ "a.ts": 'import a from "a";\n', "b.ts": "export const b = 1;\n" });
    const base = await fixture.commit("base");
    await fixture.write({ "a.ts": 'import a from "z";\n', "b.ts": "export const b = 2;\n" });
    const head = await fixture.commit("head");
    const token = "ghs_FAKEINSTALLATIONTOKEN123";
    const auth = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    const server = await serveOverHttp(fixture.remote, auth);
    try {
      const repo = await cloneAtSha({
        url: server.url,
        dir: await fixture.cloneDir(),
        headSha: head,
        otherShas: [base],
        token,
        checkout: "none",
      });
      const diff = await reviewDiff(repo, { baseSha: base });
      expect(diff.files.find((f) => f.path === "a.ts")?.mechanical).toBe(true);
      await repo.checkoutPaths(["b.ts"]);
      expect(await readFile(join(repo.dir, "b.ts"), "utf8")).toBe("export const b = 2;\n");
      expect(server.authorizations.length).toBeGreaterThan(3);
      expect(server.authorizations.every((a) => a === auth)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("refuses a wrong token, without printing it", async () => {
    const head = await fixture.commit("first");
    const server = await serveOverHttp(fixture.remote, "Basic expected");
    try {
      const error = await cloneAtSha({
        url: server.url,
        dir: await fixture.cloneDir(),
        headSha: head,
        token: "ghs_WRONGTOKEN",
      }).then(
        () => new Error("expected a failure"),
        (e: unknown) => e as Error,
      );
      expect(error.message).toMatch(/401|Authentication failed|could not read/i);
      expect(error.message).not.toContain("ghs_WRONGTOKEN");
    } finally {
      await server.close();
    }
  });

  it("treats a server error as a failure, not as a force-pushed-away commit", async () => {
    await fixture.commit("first");
    // On another branch, so head's history doesn't already contain it.
    await fixture.checkout("other", true);
    await fixture.write({ "b.txt": "y\n" });
    const first = await fixture.commit("other branch");
    await fixture.checkout("main");
    await fixture.write({ "a.txt": "x\n" });
    const head = await fixture.commit("second");
    const token = "ghs_FAKE";
    const server = await serveOverHttp(
      fixture.remote,
      `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    );
    try {
      // Count the requests a head-only clone makes, then fail the one after them: the fetch
      // of the other commit.
      // No working tree, so no lazy file fetches muddy the count.
      await cloneAtSha({
        url: server.url,
        dir: await fixture.cloneDir(),
        headSha: head,
        token,
        checkout: "none",
      });
      const headOnly = server.authorizations.length;
      server.authorizations.length = 0;
      server.failAfter(headOnly, 503);
      const error = await cloneAtSha({
        url: server.url,
        dir: await fixture.cloneDir(),
        headSha: head,
        otherShas: [first],
        token,
        checkout: "none",
      }).then(
        () => new Error("expected a failure"),
        (e: unknown) => e,
      );
      expect(server.authorizations.length).toBeGreaterThan(headOnly);
      expect(String(error)).not.toContain("expected a failure");
      expect(isMissingObjectError(error)).toBe(false);
    } finally {
      await server.close();
    }
  });

  describe("over HTTP, counting requests", () => {
    const token = "ghs_FAKE";
    const auth = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

    it("fetches many other commits in one request", async () => {
      const head = await fixture.commit("head");
      await fixture.checkout("side", true);
      const others: string[] = [];
      for (let i = 0; i < 6; i++) {
        await fixture.write({ "a.txt": `${i}\n` });
        others.push(await fixture.commit(`side ${i}`));
      }
      const server = await serveOverHttp(fixture.remote, auth);
      try {
        const counted = await cloneAtSha({
          url: server.url,
          dir: await fixture.cloneDir(),
          headSha: head,
          token,
          checkout: "none",
        });
        const forHead = server.authorizations.length;
        expect(await counted.hasCommit(others[0] ?? "")).toBe(false);
        const before = server.authorizations.length;
        await counted.fetchCommits(others);
        for (const sha of others) expect(await counted.hasCommit(sha)).toBe(true);
        // One fetch (a protocol v2 fetch is two HTTP requests), not one per commit.
        expect(server.authorizations.length - before).toBeLessThanOrEqual(forHead);
      } finally {
        await server.close();
      }
    });

    it("writes a directory with one fetch, not one per file", async () => {
      await fixture.write(
        Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`dir/f${i}.txt`, `${i}\n`])),
      );
      const head = await fixture.commit("files");
      const server = await serveOverHttp(fixture.remote, auth);
      try {
        const repo = await cloneAtSha({
          url: server.url,
          dir: await fixture.cloneDir(),
          headSha: head,
          token,
          checkout: "none",
        });
        const before = server.authorizations.length;
        await repo.checkoutPaths(["dir"]);
        expect(await readFile(join(repo.dir, "dir/f19.txt"), "utf8")).toBe("19\n");
        // git's own lazy fetch would make two requests per file (40 here).
        expect(server.authorizations.length - before).toBeLessThanOrEqual(3);
      } finally {
        await server.close();
      }
    });

    it("doesn't fetch head blobs a full checkout already wrote, or anything twice", async () => {
      await fixture.write({ "a.ts": "import a from 'a';\n" });
      const base = await fixture.commit("base");
      await fixture.write({ "a.ts": "import a from 'b';\n" });
      const head = await fixture.commit("head");
      const server = await serveOverHttp(fixture.remote, auth);
      try {
        const repo = await cloneAtSha({
          url: server.url,
          dir: await fixture.cloneDir(),
          headSha: head,
          otherShas: [base],
          token,
        });
        const [oldBlob, newBlob] = (await repo.git(["rev-parse", `${base}:a.ts`, `${head}:a.ts`]))
          .trim()
          .split("\n");
        let before = server.authorizations.length;
        await repo.readBlobs([newBlob ?? ""], { local: [newBlob ?? ""] });
        expect(server.authorizations.length).toBe(before);
        await repo.readBlobs([oldBlob ?? ""]);
        expect(server.authorizations.length).toBeGreaterThan(before);
        before = server.authorizations.length;
        expect((await repo.readBlobs([oldBlob ?? ""])).get(oldBlob ?? "")?.toString()).toBe(
          "import a from 'a';\n",
        );
        expect(server.authorizations.length).toBe(before);
      } finally {
        await server.close();
      }
    });

    it("throws an auth or server failure during a prefetch instead of hiding it", async () => {
      await fixture.write({ "a.txt": "a\n" });
      const head = await fixture.commit("head");
      const server = await serveOverHttp(fixture.remote, auth);
      try {
        const repo = await cloneAtSha({
          url: server.url,
          dir: await fixture.cloneDir(),
          headSha: head,
          token,
          checkout: "none",
        });
        const blob = (await repo.git(["rev-parse", `${head}:a.txt`])).trim();
        server.failAfter(0, 401);
        const error = await repo.readBlobs([blob]).then(
          () => new Error("expected a failure"),
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain("expected a failure");
        expect(isMissingObjectError(error)).toBe(false);
      } finally {
        await server.close();
      }
    });
  });

  it("checks out more paths than fit on one command line", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 2500 }, (_, i) => [`many/file-with-a-longish-name-${i}.txt`, `${i}\n`]),
    );
    await fixture.write(files);
    const head = await fixture.commit("many");
    const repo = await cloneAtSha({
      url: fixture.url,
      dir: await fixture.cloneDir(),
      headSha: head,
      checkout: "none",
    });
    await repo.checkoutPaths(Object.keys(files));
    expect(await readFile(join(repo.dir, "many/file-with-a-longish-name-2499.txt"), "utf8")).toBe(
      "2499\n",
    );
  }, 60_000);

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
