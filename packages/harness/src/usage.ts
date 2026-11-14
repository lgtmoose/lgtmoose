import type { HarnessUsage } from "./harness.js";

const FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const satisfies readonly (keyof HarnessUsage)[];

/** Adds two attempts' usage. A field stays unset only if neither attempt reported it. */
export function addUsage(a: HarnessUsage | undefined, b: HarnessUsage): HarnessUsage {
  if (!a) return b;
  const sum: HarnessUsage = {};
  for (const key of FIELDS) {
    const x = a[key];
    const y = b[key];
    if (x !== undefined || y !== undefined) sum[key] = (x ?? 0) + (y ?? 0);
  }
  return sum;
}
