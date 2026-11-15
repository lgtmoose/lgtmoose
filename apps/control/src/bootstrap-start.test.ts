import { describe, expect, it } from "vitest";
import { startBootstraps, type BootstrapStarter } from "./bootstrap-start.js";
import type { Bootstrap, BootstrapRequest } from "./bootstrap-store.js";

function row(id: string, repo: string): Bootstrap {
  return {
    id,
    repo,
    requestedBy: "dev",
    status: "requested",
    maxPrs: 200,
    maxCostUsd: 1000,
    beforePr: undefined,
    oldestPrRead: undefined,
    prsRead: 0,
    commentsRead: 0,
    proposed: 0,
    costUsd: 0,
    capped: false,
    executionArn: undefined,
    error: undefined,
    createdAt: new Date(),
    finishedAt: undefined,
  };
}

function starter(requested: Bootstrap[], incoming?: BootstrapStarter["incoming"]) {
  const asked: BootstrapRequest[] = [];
  const started: { name: string; input: unknown }[] = [];
  const failed: { id: string; error: string }[] = [];
  const deps: BootstrapStarter = {
    store: {
      async request(input) {
        asked.push(input);
        return { created: true, bootstrap: row("new", input.repo) };
      },
      requested: async () => requested,
      start: async () => true,
      async fail(id, error) {
        failed.push({ id, error });
      },
      failStale: async () => 0,
    },
    async startExecution(name, input) {
      started.push({ name, input });
      return `arn:${name}`;
    },
    ...(incoming === undefined ? {} : { incoming }),
    maxCostUsd: 5,
  };
  return { deps, asked, started, failed };
}

describe("startBootstraps", () => {
  it("starts a requested bootstrap on its repository's installation", async () => {
    const t = starter([row("b1", "acme/shop")]);
    const count = await startBootstraps(
      t.deps,
      new Map([["acme/shop", 42]]),
      true,
      new Date(),
      () => undefined,
    );
    expect(count).toBe(1);
    expect(t.started).toEqual([
      {
        name: "bootstrap-b1",
        input: { bootstrapId: "b1", installationId: 42, repo: "acme/shop", debounceSeconds: 0 },
      },
    ]);
  });

  it("fails one on a repository the App isn't installed on, but only when every installation was read", async () => {
    const complete = starter([row("b1", "other/repo")]);
    await startBootstraps(complete.deps, new Map(), true, new Date(), () => undefined);
    expect(complete.failed[0]?.error).toContain("isn't installed on other/repo");
    const partial = starter([row("b1", "other/repo")]);
    await startBootstraps(partial.deps, new Map(), false, new Date(), () => undefined);
    expect(partial.failed).toEqual([]);
    expect(partial.started).toEqual([]);
  });

  it("takes in the CLI's requests, never above the deployment's cost cap", async () => {
    const t = starter([], async () => [
      { version: 1, repo: "acme/shop", maxPrs: 50, maxCostUsd: 20 },
      { version: 1, repo: "acme/api", resume: true },
    ]);
    await startBootstraps(t.deps, new Map(), true, new Date(), () => undefined);
    expect(t.asked).toEqual([
      { repo: "acme/shop", requestedBy: "operator", maxPrs: 50, maxCostUsd: 5 },
      { repo: "acme/api", requestedBy: "operator", maxPrs: 200, maxCostUsd: 5, resume: true },
    ]);
  });
});
