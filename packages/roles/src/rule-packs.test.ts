import { describe, expect, it } from "vitest";
import { RulePackError, availableRulePacks, loadRulePack, loadRulePacks } from "./rule-packs.js";

describe("rule packs", () => {
  it("ships the generic pack", async () => {
    expect(await availableRulePacks()).toContain("generic");
  });

  it("loads the generic pack with the categories the prompt names", async () => {
    const pack = await loadRulePack("generic");
    expect(pack.id).toBe("generic");
    const categories = [...pack.text.matchAll(/^## (\S+)$/gm)].map((match) => match[1]);
    expect(categories).toEqual([
      "correctness",
      "error_handling",
      "security",
      "authz",
      "secrets",
      "tests",
      "wiring",
    ]);
  });

  it.each(["nope", "../package", "/etc/passwd", "generic.md", "Generic"])(
    "rejects %j",
    async (id) => {
      await expect(loadRulePack(id)).rejects.toThrow(RulePackError);
    },
  );

  it("loads each id once, in order", async () => {
    const packs = await loadRulePacks(["generic", "generic"]);
    expect(packs.map((pack) => pack.id)).toEqual(["generic"]);
  });
});
