import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  compareVersions,
  latestRelease,
  localVersion,
  RELEASES_API,
  releaseNotice,
} from "./release-check.js";

describe("compareVersions", () => {
  it("orders versions, with or without a leading v", () => {
    expect(compareVersions("0.1.0", "v0.2.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });

  it("puts a prerelease before its release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it("doesn't compare what isn't a version", () => {
    expect(compareVersions("0.1.0", "nightly")).toBeUndefined();
  });
});

describe("localVersion", () => {
  it("reads the lgtmoose package's version", () => {
    const root = mkdtempSync(join(tmpdir(), "lgtmoose-version-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "apps/cli"), { recursive: true });
    writeFileSync(join(root, "apps/cli/package.json"), JSON.stringify({ version: "0.3.1" }));
    expect(localVersion(root)).toBe("0.3.1");
  });
});

describe("latestRelease", () => {
  it("reads the latest release's tag, without credentials", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const tag = await latestRelease((url, init) => {
      seen = { url, init };
      return Promise.resolve(new Response(JSON.stringify({ tag_name: "v0.2.0" })));
    });
    expect(tag).toBe("v0.2.0");
    expect(seen?.url).toBe(RELEASES_API);
    expect(JSON.stringify(seen?.init.headers)).not.toMatch(/authorization/i);
  });

  it("is undefined before the first release", async () => {
    expect(await latestRelease(() => Promise.resolve(new Response("{}", { status: 404 })))).toBe(
      undefined,
    );
  });

  it("throws on another reply", async () => {
    await expect(
      latestRelease(() => Promise.resolve(new Response("{}", { status: 403 }))),
    ).rejects.toThrow("403");
  });
});

describe("releaseNotice", () => {
  it("warns when this checkout is older than the latest release", async () => {
    const notice = await releaseNotice({ local: "0.1.0", latest: () => Promise.resolve("v0.2.0") });
    expect(notice).toContain("this checkout is LGTMoose 0.1.0, and v0.2.0 is out");
    expect(notice).toContain("git checkout v0.2.0");
  });

  it("says nothing when it's current, newer, or there's no release", async () => {
    expect(await releaseNotice({ local: "0.2.0", latest: () => Promise.resolve("v0.2.0") })).toBe(
      undefined,
    );
    expect(await releaseNotice({ local: "0.3.0", latest: () => Promise.resolve("v0.2.0") })).toBe(
      undefined,
    );
    expect(await releaseNotice({ local: "0.0.0", latest: () => Promise.resolve(undefined) })).toBe(
      undefined,
    );
  });

  it("only notes it when the check fails, so an offline deploy still runs", async () => {
    const notice = await releaseNotice({
      local: "0.1.0",
      latest: () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com")),
    });
    expect(notice).toContain("Couldn't check for a newer LGTMoose release");
    expect(notice).toContain("deploying this checkout anyway");
  });
});
