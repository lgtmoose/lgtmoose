import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClaude, isRunning } from "./fake-claude.js";

function track(pids: number[], pid: number | undefined): void {
  if (pid !== undefined && pid > 0) pids.push(pid);
}

/** Runs one invocation and collects stdout. A missing pid is not recorded: `kill(0)` signals the whole group. */
function start(binary: string, pids: number[]): { child: ChildProcess; output: Promise<string> } {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  track(pids, child.pid);
  const output = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  child.stdin.end();
  return { child, output };
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
    fake = await FakeClaude.create([{ stdout: "first-only\n" }, { hang: true, grandchild: true }]);
    const first = start(fake.binaryPath, leftovers);
    expect(await first.output).toBe("first-only\n");
    expect(await fake.calls()).toHaveLength(1);

    const second = start(fake.binaryPath, leftovers);
    const secondPid = await waitFor(() => fake?.pid("child"));
    const secondGrandchild = await waitFor(() => fake?.pid("grandchild"));
    track(leftovers, secondGrandchild);
    expect(secondPid).toBe(second.child.pid);
    expect(isRunning(secondGrandchild)).toBe(true);

    // The first response exits. Only the second ignores SIGTERM.
    process.kill(secondPid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isRunning(secondPid)).toBe(true);
    expect(second.child.exitCode).toBeNull();
  });
});
