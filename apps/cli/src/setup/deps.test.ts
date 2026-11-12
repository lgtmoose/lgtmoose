import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath } from "./deps.js";

describe("configPath", () => {
  it("defaults to lgtmoose.config.ts at the repo root, where cdk synth looks", () => {
    const path = configPath({});
    expect(path.endsWith("/lgtmoose.config.ts")).toBe(true);
    expect(existsSync(join(dirname(path), "pnpm-workspace.yaml"))).toBe(true);
  });

  it("honours LGTMOOSE_CONFIG like infra/cdk/lib/load-config.ts", () => {
    expect(configPath({ LGTMOOSE_CONFIG: "/tmp/x.ts" })).toBe("/tmp/x.ts");
  });
});
