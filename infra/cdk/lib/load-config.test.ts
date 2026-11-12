import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./load-config.js";

describe("loadConfig", () => {
  it("falls back to the example config when no lgtmoose.config.ts exists", async () => {
    const { config, path } = await loadConfig({ LGTMOOSE_CONFIG: undefined });
    expect(path).toBeUndefined();
    expect(config.profile).toBe("lean");
    expect(config.providers[0]?.auth).toBe("bedrock");
  });

  it("loads and validates the file LGTMOOSE_CONFIG points at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lgtmoose-config-"));
    const file = join(dir, "lgtmoose.config.mjs");
    writeFileSync(
      file,
      `export default { profile: "standard", allowedOrgs: ["acme"], providers: [{ id: "c", harness: "codex", auth: "api-key" }] };`,
    );
    const { config, path } = await loadConfig({ LGTMOOSE_CONFIG: file });
    expect(path).toBe(file);
    expect(config.profile).toBe("standard");
  });

  it("names the file when its config is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lgtmoose-config-"));
    const file = join(dir, "bad.mjs");
    writeFileSync(file, `export default { allowedOrgs: [], providers: [] };`);
    await expect(loadConfig({ LGTMOOSE_CONFIG: file })).rejects.toThrow(`${file} is invalid`);
  });

  it("fails clearly when LGTMOOSE_CONFIG points at a missing file", async () => {
    await expect(loadConfig({ LGTMOOSE_CONFIG: "/nope/lgtmoose.config.ts" })).rejects.toThrow(
      "doesn't exist",
    );
  });
});
