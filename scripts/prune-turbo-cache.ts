/**
 * Keeps only the turbo cache entries the latest run used. CI restores the previous cache and
 * saves it again under a new key, so without this the cache only ever grows. Needs a run with
 * `--summarize`, which writes .turbo/runs/<id>.json listing every task's hash.
 */
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const runsDir = join(root, ".turbo/runs");
const cacheDir = join(root, ".turbo/cache");

const runs = readdirSync(runsDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => join(runsDir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const latest = runs[0];
if (latest === undefined)
  throw new Error(`No run summary in ${runsDir}; run turbo with --summarize.`);

const summary = JSON.parse(readFileSync(latest, "utf8")) as { tasks: { hash: string }[] };
const keep = new Set(summary.tasks.map((task) => task.hash));

let removed = 0;
for (const name of readdirSync(cacheDir)) {
  // Entries are <hash>.tar.zst and <hash>-meta.json.
  const hash = name.split(/[.-]/)[0] ?? "";
  if (!keep.has(hash)) {
    rmSync(join(cacheDir, name), { force: true });
    removed += 1;
  }
}
console.log(`Kept ${keep.size} task results, removed ${removed} stale cache files.`);
