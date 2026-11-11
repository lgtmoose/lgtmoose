import { describe, expect, it } from "vitest";
import { COMMANDS, VERSION, run } from "./cli.js";

describe("lgtmoose CLI", () => {
  it("prints help with no arguments", () => {
    const result = run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: lgtmoose <command>");
    for (const name of Object.keys(COMMANDS)) {
      expect(result.stdout).toContain(name);
    }
  });

  it("prints the version", () => {
    expect(run(["--version"]).stdout).toBe(`${VERSION}\n`);
  });

  it("rejects unknown commands with help on stderr", () => {
    const result = run(["frobnicate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command "frobnicate"');
  });

  it("says which ticket builds a planned command", () => {
    const result = run(["setup"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("NIC-802");
  });
});
