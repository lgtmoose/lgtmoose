import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCdk, deployArgs, destroyArgs } from "./cdk.js";

describe("cdk arguments", () => {
  it("deploys everything, writing outputs, asking only about broadened access", () => {
    expect(deployArgs({ stacks: "all", askToApprove: true }, "/tmp/o.json")).toEqual([
      "deploy",
      "--all",
      "--require-approval",
      "broadening",
      "--outputs-file",
      "/tmp/o.json",
    ]);
  });

  it("deploys one stack alone with context flags", () => {
    expect(
      deployArgs(
        {
          stacks: ["Lgtmoose-Data"],
          exclusively: true,
          askToApprove: false,
          context: { a: "true" },
        },
        "/o",
      ),
    ).toEqual([
      "deploy",
      "Lgtmoose-Data",
      "--exclusively",
      "--require-approval",
      "never",
      "--outputs-file",
      "/o",
      "-c",
      "a=true",
    ]);
  });

  it("destroys every stack without the CDK's own prompt", () => {
    expect(destroyArgs({ a: "true" })).toEqual(["destroy", "--all", "--force", "-c", "a=true"]);
  });
});

describe("createCdk", () => {
  function fakeCdkDir() {
    const dir = mkdtempSync(join(tmpdir(), "cdk-test-"));
    mkdirSync(join(dir, "node_modules/aws-cdk/bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules/aws-cdk/bin/cdk"), "");
    return dir;
  }

  function fakeSpawn(exitCode: number, onRun?: (args: string[]) => void) {
    return vi.fn((_cmd: string, args: readonly string[]) => {
      onRun?.([...args]);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", exitCode, null));
      return child;
    });
  }

  it("runs the CDK with the config and region, and returns the outputs", async () => {
    const cdkDir = fakeCdkDir();
    const spawn = fakeSpawn(0, (args) => {
      const file = args[args.indexOf("--outputs-file") + 1] ?? "";
      writeFileSync(file, JSON.stringify({ "Lgtmoose-Api": { GithubWebhookUrl: "https://x" } }));
    });
    const cdk = createCdk({
      configPath: "/repo/lgtmoose.config.ts",
      region: "eu-west-2",
      cdkDir,
      spawn: spawn as never,
    });
    await expect(cdk.deploy({ stacks: "all", askToApprove: true })).resolves.toEqual({
      "Lgtmoose-Api": { GithubWebhookUrl: "https://x" },
    });
    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ];
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe(join(cdkDir, "node_modules/aws-cdk/bin/cdk"));
    expect(options.cwd).toBe(cdkDir);
    expect(options.env.LGTMOOSE_CONFIG).toBe("/repo/lgtmoose.config.ts");
    expect(options.env.AWS_REGION).toBe("eu-west-2");
  });

  it("fails when the CDK exits non-zero", async () => {
    const cdk = createCdk({
      configPath: "/c",
      region: "us-east-1",
      cdkDir: fakeCdkDir(),
      spawn: fakeSpawn(1) as never,
    });
    await expect(cdk.bootstrap()).rejects.toThrow("cdk bootstrap failed (exit code 1)");
  });

  it("says to install dependencies when the CDK CLI is missing", async () => {
    const cdk = createCdk({ configPath: "/c", region: "us-east-1", cdkDir: tmpdir() });
    await expect(cdk.destroyAll()).rejects.toThrow("Run pnpm install");
  });
});
