import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import { DEFAULT_CONVENTIONS, parseRepoConfigYaml, statusLabels } from "./repo.js";

describe("parseRepoConfigYaml", () => {
  it("gives the defaults for a missing or empty file", () => {
    const expected = {
      rulepacks: ["generic"],
      conventions: [...DEFAULT_CONVENTIONS],
      tiers: {},
      skip: [],
      include: [],
      registries: [],
      gate: { check_run: "required", approve: true, nit_cap: 10 },
      injection: { allow: [] },
      review: {
        trigger: "auto",
        on_push: "auto",
        label: "lgtmoose:review",
        label_once: false,
        trusted_bots: [],
      },
      labels: { pending: "Ready for Review", changes: "Requires Changes", approved: "Approved" },
      budgets: { per_pull_request: {} },
    };
    expect(parseRepoConfigYaml(undefined)).toEqual(expected);
    expect(parseRepoConfigYaml("")).toEqual(expected);
  });

  it("parses the example from the architecture doc", () => {
    const config = parseRepoConfigYaml(`
rulepacks: [generic, security, typescript, ./rules/our-tenancy.md]
conventions: [CLAUDE.md, AGENTS.md, .cursor/rules/*.mdc]
tiers:
  1: ["src/middleware/**", "src/auth/**"]
  2: ["src/payments/**"]
skip: ["**/generated/**", "dist/**"]
gate: { check_run: required, approve: true, nit_cap: 10 }
labels: { pending: "Ready for Review", changes: "Requires Changes", approved: "Approved" }
`);
    expect(config.rulepacks).toContain("./rules/our-tenancy.md");
    expect(config.tiers).toEqual({
      "1": ["src/middleware/**", "src/auth/**"],
      "2": ["src/payments/**"],
    });
    expect(config.gate.nit_cap).toBe(10);
  });

  it("parses include globs and rejects empty ones", () => {
    expect(parseRepoConfigYaml('include: ["src/build/**"]\n').include).toEqual(["src/build/**"]);
    expect(() => parseRepoConfigYaml('include: [""]\n')).toThrow(ConfigError);
  });

  it("fills missing nested defaults when a section is partly set", () => {
    const config = parseRepoConfigYaml("gate:\n  approve: false\nlabels:\n  approved: LGTM\n");
    expect(config.gate).toEqual({ check_run: "required", approve: false, nit_cap: 10 });
    expect(statusLabels(config)).toEqual(["Ready for Review", "Requires Changes", "LGTM"]);
  });

  it("names the bad key", () => {
    try {
      parseRepoConfigYaml("tiers:\n  9: ['src/**']\n");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues[0]?.path).toBe("tiers.9");
    }
  });

  it("reports invalid YAML with its line number", () => {
    expect(() => parseRepoConfigYaml("rulepacks: [generic\nskip: x\n")).toThrow(
      /\.lgtmoose\.yaml is invalid:\n {2}- \(root\): not valid YAML/,
    );
  });

  it("rejects unknown keys", () => {
    expect(() => parseRepoConfigYaml("rulepack: [generic]\n")).toThrow(/rulepack/);
  });
});
