import { describe, expect, it } from "vitest";
import { syncStatusLabel, type LabelClient } from "./labels.js";

const STATUS = ["Ready for Review", "Requires Changes", "Approved"] as const;

class FakeLabels implements LabelClient {
  calls: string[] = [];
  /** Labels someone else adds right after our first change, to simulate a race. */
  interference: string[] = [];

  constructor(
    public repo: string[],
    public pr: string[],
  ) {}

  async listRepoLabels(): Promise<string[]> {
    return [...this.repo];
  }

  async listPrLabels(): Promise<string[]> {
    return [...this.pr];
  }

  async addPrLabels(labels: readonly string[]): Promise<void> {
    for (const label of labels) {
      if (!this.repo.includes(label)) throw new Error(`label ${label} doesn't exist`);
      if (!this.pr.includes(label)) this.pr.push(label);
    }
    this.calls.push(`add ${labels.join(",")}`);
    this.pr.push(...this.interference.splice(0));
  }

  async removePrLabel(label: string): Promise<void> {
    this.pr = this.pr.filter((l) => l !== label);
    this.calls.push(`remove ${label}`);
  }
}

describe("syncStatusLabel", () => {
  it("adds the target, removes the other status labels and keeps the rest", async () => {
    const client = new FakeLabels([...STATUS, "bug"], ["bug", "Requires Changes"]);
    const result = await syncStatusLabel(client, { target: "Approved", statusLabels: STATUS });
    expect(result).toEqual({
      ok: true,
      added: ["Approved"],
      removed: ["Requires Changes"],
      missing: [],
      labels: ["bug", "Approved"],
    });
    expect(client.calls).toEqual(["remove Requires Changes", "add Approved"]);
  });

  it("makes no calls when the PR already has just the target", async () => {
    const client = new FakeLabels([...STATUS], ["Approved", "docs"]);
    const result = await syncStatusLabel(client, { target: "Approved", statusLabels: STATUS });
    expect(result.ok).toBe(true);
    expect(client.calls).toEqual([]);
  });

  it("matches labels regardless of case and uses the repository's spelling", async () => {
    const client = new FakeLabels(
      ["ready for review", "Requires Changes", "APPROVED"],
      ["ready for review"],
    );
    const result = await syncStatusLabel(client, { target: "Approved", statusLabels: STATUS });
    expect(result).toMatchObject({ ok: true, added: ["APPROVED"], removed: ["ready for review"] });
  });

  it("never creates a missing label, still removes stale ones, and says so", async () => {
    const client = new FakeLabels(["Ready for Review", "Requires Changes"], ["Requires Changes"]);
    const result = await syncStatusLabel(client, { target: "Approved", statusLabels: STATUS });
    expect(result).toMatchObject({
      ok: false,
      added: [],
      removed: ["Requires Changes"],
      missing: ["Approved"],
    });
    expect(result.problem).toContain('no "Approved" label');
    expect(client.repo).not.toContain("Approved");
  });

  it("reports a missing label that isn't the target, while still syncing", async () => {
    const client = new FakeLabels(["Ready for Review", "Approved"], []);
    const result = await syncStatusLabel(client, { target: "Approved", statusLabels: STATUS });
    expect(result).toMatchObject({ ok: true, missing: ["Requires Changes"], labels: ["Approved"] });
    expect(result.problem).toContain('"Requires Changes"');
  });

  it("reads the labels back and tries again when someone changed them meanwhile", async () => {
    const client = new FakeLabels([...STATUS], ["Ready for Review"]);
    client.interference = ["Requires Changes"];
    const result = await syncStatusLabel(client, { target: "Approved", statusLabels: STATUS });
    expect(result.ok).toBe(true);
    expect(client.calls).toEqual([
      "remove Ready for Review",
      "add Approved",
      "remove Requires Changes",
    ]);
  });

  it("reports when the labels still don't match after two tries", async () => {
    const client = new FakeLabels([...STATUS], []);
    client.removePrLabel = async () => {};
    client.pr = ["Requires Changes"];
    const result = await syncStatusLabel(client, { target: "Approved", statusLabels: STATUS });
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("didn't match");
  });

  it("refuses a target that isn't a status label", async () => {
    const client = new FakeLabels([...STATUS, "bug"], []);
    await expect(syncStatusLabel(client, { target: "bug", statusLabels: STATUS })).rejects.toThrow(
      "isn't one of the status labels",
    );
  });
});
