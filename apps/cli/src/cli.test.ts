import { describe, expect, it, vi } from "vitest";
import { COMMANDS, VERSION, run } from "./cli.js";

describe("lgtmoose CLI", () => {
  it("prints help with no arguments", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: lgtmoose <command>");
    for (const name of Object.keys(COMMANDS)) {
      expect(result.stdout).toContain(name);
    }
  });

  it("prints the version", async () => {
    expect((await run(["--version"])).stdout).toBe(`${VERSION}\n`);
  });

  it("rejects unknown commands with help on stderr", async () => {
    const result = await run(["frobnicate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command "frobnicate"');
  });

  it("says which ticket builds a planned command", async () => {
    const result = await run(["auth"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("NIC-824");
  });

  it("hands setup its own flags and help", async () => {
    const setupDeps = vi.fn();
    const result = await run(["setup", "--help"], { setupDeps });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: lgtmoose setup");
    expect(setupDeps).not.toHaveBeenCalled();
  });

  it("rejects bad setup flags before touching GitHub or AWS", async () => {
    const setupDeps = vi.fn();
    const result = await run(["setup", "--profile", "huge"], { setupDeps });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--profile "huge"');
    expect(setupDeps).not.toHaveBeenCalled();
  });

  it("hands deploy and destroy their own flags and help", async () => {
    const deployDeps = vi.fn();
    const deploy = await run(["deploy", "--help"], { deployDeps });
    expect(deploy.stdout).toContain("Usage: lgtmoose deploy");
    const destroy = await run(["destroy", "--nope"], { deployDeps });
    expect(destroy.exitCode).toBe(1);
    expect(destroy.stderr).toContain("Usage: lgtmoose destroy");
    expect(deployDeps).not.toHaveBeenCalled();
  });
});
