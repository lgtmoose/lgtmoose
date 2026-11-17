import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClaude, isRunning, waitGone } from "./fake-claude.js";

function start(binary: string): ChildProcess {
  const child = spawn(binary, [], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end();
  return child;
}

async function waitFor(read: () => number | undefined, ms = 5000): Promise<number> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const pid = read();
      if (pid !== undefined && pid > 0 && isRunning(pid)) return pid;
    } catch {
      // The pid file is not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for a pid");
}

describe("FakeClaude", () => {
  let fake: FakeClaude | undefined;
  const leftovers: number[] = [];

  afterEach(async () => {
    for (const pid of leftovers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    leftovers.length = 0;
    await fake?.destroy();
    fake = undefined;
  });

  it("arms this invocation's response, not the first one's", async () => {
    fake = await FakeClaude.create([
      { hang: true, grandchild: true },
      { hang: true, grandchild: true },
    ]);
    const first = start(fake.binaryPath);
    leftovers.push(first.pid ?? 0);
    const firstPid = await waitFor(() => fake?.pid("child"));
    const firstGrandchild = await waitFor(() => fake?.pid("grandchild"));
    leftovers.push(firstGrandchild);
    const recorded = Date.now() + 5000;
    while ((await fake.calls()).length < 1) {
      if (Date.now() > recorded) throw new Error("the first invocation never recorded its call");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    process.kill(firstPid, "SIGKILL");
    process.kill(firstGrandchild, "SIGKILL");
    expect(await waitGone(firstPid)).toBe(true);
    expect(await waitGone(firstGrandchild)).toBe(true);

    const second = start(fake.binaryPath);
    leftovers.push(second.pid ?? 0);
    const secondPid = await waitFor(() => {
      const pid = fake?.pid("child");
      return pid !== undefined && pid !== firstPid ? pid : undefined;
    });
    const secondGrandchild = await waitFor(() => {
      const pid = fake?.pid("grandchild");
      return pid !== undefined && pid !== firstGrandchild ? pid : undefined;
    });
    leftovers.push(secondGrandchild);
    expect(secondPid).toBe(second.pid);
    expect(isRunning(secondGrandchild)).toBe(true);

    process.kill(secondPid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isRunning(secondPid)).toBe(true);
  });
});
