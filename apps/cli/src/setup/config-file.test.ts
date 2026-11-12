import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, parseDeployConfig } from "@lgtmoose/config";
import { format } from "prettier";
import { afterAll, describe, expect, it } from "vitest";
import { renderConfigFile } from "./config-file.js";

const settings = { region: "eu-west-1", profile: "standard", owner: "acme" } as const;
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Writes the file next to a node_modules/@lgtmoose/config link, as at the repo root, and loads it. */
async function load(text: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "lgtmoose-setup-"));
  dirs.push(dir);
  const configPackage = join(
    dirname(createRequire(import.meta.url).resolve("@lgtmoose/config")),
    "..",
  );
  mkdirSync(join(dir, "node_modules", "@lgtmoose"), { recursive: true });
  symlinkSync(configPackage, join(dir, "node_modules", "@lgtmoose", "config"), "dir");
  // The rendered file is plain JavaScript, so it loads as .mjs without a TypeScript loader.
  const file = join(dir, "lgtmoose.config.mjs");
  writeFileSync(file, text);
  const module = (await import(pathToFileURL(file).href)) as { default: unknown };
  return module.default;
}

describe("renderConfigFile", () => {
  it("writes a config that parseDeployConfig accepts", async () => {
    const config = parseDeployConfig(await load(renderConfigFile(settings)));
    expect(config).toMatchObject({
      region: "eu-west-1",
      profile: "standard",
      allowedOrgs: ["acme"],
      providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
    });
  });

  it("uses defineConfig, so editors type-check the file", () => {
    const text = renderConfigFile(settings);
    expect(text).toContain('import { defineConfig } from "@lgtmoose/config";');
    expect(text).toContain("export default defineConfig({");
  });

  it("is already formatted the way Prettier would", async () => {
    const text = renderConfigFile(settings);
    expect(
      await format(text, { parser: "typescript", printWidth: 100, trailingComma: "all" }),
    ).toBe(text);
  });

  it("refuses to render an invalid config", () => {
    expect(() => renderConfigFile({ ...settings, owner: "-bad-" })).toThrow(ConfigError);
  });
});
