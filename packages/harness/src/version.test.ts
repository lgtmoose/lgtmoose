import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_VERSION,
  CODEX_VERSION,
  CURSOR_AGENT_SHA256,
  CURSOR_AGENT_VERSION,
} from "./version.js";

const run = promisify(execFile);
const DOCKERFILE = join(import.meta.dirname, "../../../infra/sandbox/Dockerfile");

describe("CLAUDE_CODE_VERSION", () => {
  it("is an exact version", () => {
    expect(CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the version the sandbox image installs", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    const pinned = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(pinned).toBe(CLAUDE_CODE_VERSION);
    expect(dockerfile).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
  });
});

describe("CODEX_VERSION", () => {
  it("is an exact version that matches the sandbox image", async () => {
    expect(CODEX_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    expect(/^ARG CODEX_VERSION=(\S+)$/m.exec(dockerfile)?.[1]).toBe(CODEX_VERSION);
    expect(dockerfile).toContain('"@openai/codex@${CODEX_VERSION}"');
  });
});

describe("CURSOR_AGENT_VERSION", () => {
  it("is an exact build, with a checksum slot per architecture", () => {
    expect(CURSOR_AGENT_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/);
    for (const sha of Object.values(CURSOR_AGENT_SHA256)) expect(sha).toMatch(/^(|[0-9a-f]{64})$/);
    expect(Object.keys(CURSOR_AGENT_SHA256).sort()).toEqual(["amd64", "arm64"]);
  });
});

/**
 * The cursor stage's RUN script, run with sh against a stub download, so its guards are tested
 * without Docker. Paths are moved into a temp dir; apt-get and curl are stubs.
 */
/** The step runs in Debian; GNU sha256sum isn't on macOS by default. */
const hasSha256sum = await run("sha256sum", ["--version"]).then(
  () => true,
  () => false,
);

describe.skipIf(!hasSha256sum)("the sandbox image's Cursor install step", () => {
  let dir: string;
  let tarball: Buffer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lgtmoose-cursor-stage-"));
    const pkg = join(dir, "pkg", "dist-package");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "cursor-agent"), "#!/bin/sh\n");
    await chmod(join(pkg, "cursor-agent"), 0o755);
    await run("tar", ["-czf", join(dir, "fixture.tar.gz"), "-C", join(dir, "pkg"), "dist-package"]);
    tarball = await readFile(join(dir, "fixture.tar.gz"));
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "apt-get"), "#!/bin/sh\nexit 0\n");
    // curl -fsSL ... -o <file> <url>: copies the fixture and records the URL.
    await writeFile(
      join(bin, "curl"),
      `#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "${join(dir, "fixture.tar.gz")}" "$2"\necho "$3" > "${join(dir, "url")}"\n`,
    );
    await chmod(join(bin, "apt-get"), 0o755);
    await chmod(join(bin, "curl"), 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function stage(args: Record<string, string>) {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    const section = dockerfile.slice(dockerfile.indexOf(" AS cursor"));
    const lines = section.split("\n");
    const start = lines.findIndex((line) => line.startsWith("RUN "));
    const body: string[] = [];
    for (const line of lines.slice(start)) {
      body.push(line.replace(/\\$/, ""));
      if (!line.endsWith("\\")) break;
    }
    const script = body
      .join(" ")
      .replace(/^RUN /, "")
      .replaceAll("/opt/cursor-agent", join(dir, "opt"))
      .replaceAll("/tmp/agent.tar.gz", join(dir, "agent.tar.gz"));
    const env = {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      TARGETARCH: "arm64",
      // Docker sets each `ARG NAME=` to its empty default when the build passes none.
      INSTALL_CURSOR_AGENT: "",
      CURSOR_AGENT_VERSION: "",
      CURSOR_AGENT_SHA256: "",
      ALLOW_UNVERIFIED_CURSOR: "",
      ...args,
    };
    return run("sh", ["-c", script], { env }).then(
      ({ stderr }) => ({ ok: true as const, stderr }),
      (error: { stderr?: string }) => ({ ok: false as const, stderr: error.stderr ?? "" }),
    );
  }

  const sha = () => createHash("sha256").update(tarball).digest("hex");

  it("downloads nothing without INSTALL_CURSOR_AGENT", async () => {
    expect((await stage({})).ok).toBe(true);
    expect(await readdir(join(dir, "opt"))).toEqual([]);
    expect(await readdir(dir)).not.toContain("url");
  });

  it("installs the pinned build when its checksum matches", async () => {
    const result = await stage({
      INSTALL_CURSOR_AGENT: "1",
      CURSOR_AGENT_VERSION,
      CURSOR_AGENT_SHA256: sha(),
    });
    expect(result.ok).toBe(true);
    expect(await readdir(join(dir, "opt"))).toEqual(["cursor-agent"]);
    expect(await readFile(join(dir, "url"), "utf8")).toContain(
      `/lab/${CURSOR_AGENT_VERSION}/linux/arm64/agent-cli-package.tar.gz`,
    );
  });

  it("fails on a wrong checksum", async () => {
    const result = await stage({
      INSTALL_CURSOR_AGENT: "1",
      CURSOR_AGENT_VERSION,
      CURSOR_AGENT_SHA256: "0".repeat(64),
    });
    expect(result.ok).toBe(false);
  });

  it("fails without a checksum unless the build opts out explicitly", async () => {
    const refused = await stage({ INSTALL_CURSOR_AGENT: "1", CURSOR_AGENT_VERSION });
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toContain("CURSOR_AGENT_SHA256 is not set");
    const allowed = await stage({
      INSTALL_CURSOR_AGENT: "1",
      CURSOR_AGENT_VERSION,
      ALLOW_UNVERIFIED_CURSOR: "1",
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.stderr).toContain("not verified");
  });

  it("fails without a version", async () => {
    expect((await stage({ INSTALL_CURSOR_AGENT: "1", ALLOW_UNVERIFIED_CURSOR: "1" })).ok).toBe(
      false,
    );
  });
});
