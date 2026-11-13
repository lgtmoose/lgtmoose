import { readdir, readFile } from "node:fs/promises";

/**
 * Rule packs are markdown files in the package's `rulepacks` folder, loaded by id (the file name
 * without `.md`). The folder sits next to both `src` and `dist`, so one relative URL works from
 * either.
 */
export const RULE_PACK_DIR = new URL("../rulepacks/", import.meta.url);

export interface RulePack {
  id: string;
  text: string;
}

/** Ids come from the repo's `.lgtmoose.yaml`, which a PR can change, so they never name a path. */
const RULE_PACK_ID = /^[a-z0-9][a-z0-9-]*$/;

export class RulePackError extends Error {
  override name = "RulePackError";
}

/** Ids of the rule packs shipped with this package, sorted. */
export async function availableRulePacks(dir: URL = RULE_PACK_DIR): Promise<string[]> {
  const names = await readdir(dir);
  return names
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .filter((id) => RULE_PACK_ID.test(id))
    .sort();
}

/** Loads one rule pack by id. Throws a RulePackError for a bad or unknown id. */
export async function loadRulePack(id: string, dir: URL = RULE_PACK_DIR): Promise<RulePack> {
  const available = await availableRulePacks(dir);
  if (!RULE_PACK_ID.test(id) || !available.includes(id)) {
    throw new RulePackError(
      `Unknown rule pack "${id}". Available rule packs: ${available.join(", ")}.`,
    );
  }
  const text = await readFile(new URL(`${id}.md`, dir), "utf8");
  return { id, text: text.trim() };
}

/** Loads rule packs in the order given, once each. */
export async function loadRulePacks(
  ids: readonly string[],
  dir: URL = RULE_PACK_DIR,
): Promise<RulePack[]> {
  return Promise.all([...new Set(ids)].map((id) => loadRulePack(id, dir)));
}
