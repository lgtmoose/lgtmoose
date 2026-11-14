import { describe, expect, it } from "vitest";
import { pool } from "./pool.js";

describe("pool", () => {
  it("runs at most `limit` at once and keeps the order of results", async () => {
    let running = 0;
    let most = 0;
    const results = await pool([5, 1, 3, 2, 4], 2, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running -= 1;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 30, 20, 40]);
    expect(most).toBe(2);
  });

  it("starts no more jobs after one fails", async () => {
    const started: number[] = [];
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await expect(
      pool([0, 1, 2, 3], 2, async (n) => {
        started.push(n);
        // Job 0 fails while job 1, on the other worker, is still running.
        if (n === 0) {
          await sleep(5);
          throw new Error("boom");
        }
        await sleep(20);
        return n;
      }),
    ).rejects.toThrow("boom");
    // Let the other worker finish its job: it mustn't pick up another.
    await sleep(80);
    expect(started).toEqual([0, 1]);
  });
});
