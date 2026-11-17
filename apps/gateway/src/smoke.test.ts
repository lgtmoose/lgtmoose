import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { CommitStatusJob, ReviewJob } from "@lgtmoose/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { ROUTES } from "./paths.js";
import { report, runWebhookSmoke } from "./smoke.js";

const SECRET = "smoke-secret";

let server: Server | undefined;

afterEach(async () => {
  server?.close();
  server = undefined;
});

/** The real gateway app on a local port, with a queue that records jobs. */
async function gateway(
  secret = SECRET,
): Promise<{ url: string; jobs: (ReviewJob | CommitStatusJob)[] }> {
  const jobs: (ReviewJob | CommitStatusJob)[] = [];
  const app = createApp(
    { version: "test", trustProxyHops: 0 },
    {
      secrets: { get: async () => secret },
      queue: { send: async (job) => void jobs.push(job) },
      allowedOrgs: ["acme-corp"],
    },
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}${ROUTES.githubWebhook}`, jobs };
}

describe("runWebhookSmoke", () => {
  it("passes against a gateway that verifies and queues, and queues one comment job", async () => {
    const { url, jobs } = await gateway();
    let n = 0;
    const result = await runWebhookSmoke({
      webhookUrl: url,
      secret: SECRET,
      owner: "Acme-Corp",
      newId: () => `smoke-${++n}`,
      now: () => new Date("2026-11-14T12:00:00Z"),
    });
    expect(report(result).ok).toBe(true);
    expect(result.deliveryId).toBe("smoke-3");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "comment",
      deliveryId: "smoke-3",
      repo: "Acme-Corp/lgtmoose-smoke-test",
      prNumber: 1,
      commentId: 1,
    });
  });

  it("fails every signed check when the secret is wrong, and queues nothing", async () => {
    const { url, jobs } = await gateway("another-secret");
    const result = await runWebhookSmoke({ webhookUrl: url, secret: SECRET, owner: "acme-corp" });
    const { ok, lines } = report(result);
    expect(ok).toBe(false);
    expect(result.checks.map((check) => check.ok)).toEqual([false, true, false]);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(jobs).toEqual([]);
  });

  it("fails the queue check when the owner isn't allowed", async () => {
    const { url, jobs } = await gateway();
    const result = await runWebhookSmoke({
      webhookUrl: url,
      secret: SECRET,
      owner: "someone-else",
    });
    expect(result.checks.at(-1)).toMatchObject({ ok: false });
    expect(result.checks.at(-1)?.detail).toContain("owner not allowed");
    expect(jobs).toEqual([]);
  });

  it("fails the forged check when a gateway accepts any signature", async () => {
    const accepting = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const result = await runWebhookSmoke({
      webhookUrl: "https://gateway.invalid/webhooks/github",
      secret: SECRET,
      owner: "acme-corp",
      fetch: accepting,
    });
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["signed ping is accepted", true],
      ["wrongly signed ping is refused", false],
      ["signed PR comment is queued", false],
    ]);
  });
});
