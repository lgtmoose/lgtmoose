import { readFileSync } from "node:fs";
import type { ReviewJob } from "@lgtmoose/core";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { ROUTES } from "./paths.js";
import type { JobQueue, SecretStore, SendOptions } from "./ports.js";
import { parsePayload } from "./routes/webhooks.js";
import { parseSignature, signBody, signatureMatches } from "./signature.js";

const SECRET = "It's a Secret to Everybody";
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
const NOW = new Date("2026-11-12T10:00:00.000Z");

/** Recorded-style payloads: real GitHub shapes, trimmed, with made-up orgs, users and IDs. */
function fixture(name: string): Buffer {
  return readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url));
}

/** The fixture fields tests change. */
interface Fixture {
  action: string;
  pull_request: { draft: boolean; labels: { name: string }[] };
  sender: Record<string, unknown>;
  repository: { full_name: string; owner: { login: string } };
}

/** A fixture with some fields changed, re-serialised (and so re-signed) like a new delivery. */
function modified(name: string, change: (payload: Fixture) => void): string {
  const payload = JSON.parse(fixture(name).toString("utf8")) as Fixture;
  change(payload);
  return JSON.stringify(payload);
}

/** A secret store whose value can be rotated; `get` counts calls and records refreshes. */
function rotatingSecrets(initial: string) {
  let current = initial;
  let cached = initial;
  const get = vi.fn(async (options?: { refresh?: boolean }) => {
    if (options?.refresh === true) cached = current;
    return cached;
  });
  const store: SecretStore = { get };
  return { store, get, rotate: (next: string) => void (current = next) };
}

function setup(options: { secrets?: SecretStore; send?: JobQueue["send"] } = {}) {
  const sent: { job: ReviewJob; options: SendOptions }[] = [];
  const send = vi.fn(
    options.send ??
      (async (job: ReviewJob, sendOptions: SendOptions) => {
        sent.push({ job, options: sendOptions });
      }),
  );
  const app = createApp(
    { version: "test", trustProxyHops: 0 },
    {
      secrets: options.secrets ?? { get: async () => SECRET },
      queue: { send },
      allowedOrgs: ["Acme-Corp"],
      now: () => NOW,
    },
  );
  return { app, send, sent };
}

interface DeliverOptions {
  event?: string | undefined;
  delivery?: string | undefined;
  signature?: string | undefined;
  secret?: string;
  contentType?: string;
}

function deliver(
  app: ReturnType<typeof setup>["app"],
  body: Buffer | string,
  opts: DeliverOptions = {},
) {
  const has = (key: keyof DeliverOptions) => Object.prototype.hasOwnProperty.call(opts, key);
  const req = request(app)
    .post(ROUTES.githubWebhook)
    .set("content-type", opts.contentType ?? "application/json")
    .set("user-agent", "GitHub-Hookshot/abc1234");
  const event = has("event") ? opts.event : "pull_request";
  const delivery = has("delivery") ? opts.delivery : DELIVERY;
  const signature = has("signature") ? opts.signature : signBody(body, opts.secret ?? SECRET);
  if (event !== undefined) req.set("x-github-event", event);
  if (delivery !== undefined) req.set("x-github-delivery", delivery);
  if (signature !== undefined) req.set("x-hub-signature-256", signature);
  // superagent JSON-encodes a Buffer sent as application/json, but sends a string as-is.
  return req.send(Buffer.isBuffer(body) ? body.toString("utf8") : body);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signature helpers", () => {
  it("matches GitHub's documented test vector", () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    const header = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(signBody("Hello, World!", SECRET)).toBe(header);
    const signature = parseSignature(header);
    expect(signature).toBeDefined();
    expect(signatureMatches(Buffer.from("Hello, World!"), signature as Buffer, SECRET)).toBe(true);
    expect(signatureMatches(Buffer.from("Hello, World?"), signature as Buffer, SECRET)).toBe(false);
  });

  it("rejects malformed headers before any comparison", () => {
    const hex = "a".repeat(64);
    for (const header of [
      undefined,
      "",
      hex,
      `sha1=${"a".repeat(40)}`,
      `sha256=${"a".repeat(63)}`,
      `sha256=${"a".repeat(66)}`,
      `sha256=${"g".repeat(64)}`,
      ` sha256=${hex}`,
    ]) {
      expect(parseSignature(header)).toBeUndefined();
    }
    expect(parseSignature(`sha256=${hex.toUpperCase()}`)).toHaveLength(32);
  });

  it("never verifies with an empty secret or a digest of the wrong length", () => {
    const body = Buffer.from("x");
    const emptyKeyDigest = parseSignature(signBody(body, "")) as Buffer;
    expect(signatureMatches(body, emptyKeyDigest, "")).toBe(false);
    expect(signatureMatches(body, Buffer.alloc(16), SECRET)).toBe(false);
  });
});

describe("POST /webhooks/github: queued jobs", () => {
  it("queues a signed pull_request.opened with the PR as the group and the delivery as dedupe ID", async () => {
    const { app, sent } = setup();
    const response = await deliver(app, fixture("pull_request.opened"));
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ queued: true });
    expect(sent).toEqual([
      {
        job: {
          kind: "pr_opened",
          deliveryId: DELIVERY,
          installationId: 55667788,
          repo: "acme-corp/widgets",
          prNumber: 42,
          headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
          actor: "octo-dev",
          receivedAt: NOW.toISOString(),
        },
        options: { groupId: "acme-corp/widgets#42", dedupeId: DELIVERY },
      },
    ]);
  });

  it.each([
    ["pull_request", "pull_request.synchronize", { kind: "pr_updated" }],
    ["pull_request", "pull_request.ready_for_review", { kind: "pr_ready" }],
    ["pull_request", "pull_request.closed", { kind: "pr_closed" }],
    ["issue_comment", "issue_comment.created", { kind: "comment", commentId: 2501234567 }],
    [
      "pull_request_review",
      "pull_request_review.submitted",
      { kind: "review", reviewId: 2301234567 },
    ],
    [
      "pull_request_review_comment",
      "pull_request_review_comment.created",
      { kind: "review_comment", commentId: 1801234567 },
    ],
    [
      "pull_request_review_thread",
      "pull_request_review_thread.resolved",
      { kind: "thread_resolved", threadNodeId: "PRRT_kwDOMFxyzc5Ab1Cd" },
    ],
  ])("queues %s from %s", async (event, name, expected) => {
    const { app, sent } = setup();
    const response = await deliver(app, fixture(name), { event });
    expect(response.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.job).toMatchObject({ ...expected, repo: "acme-corp/widgets", prNumber: 42 });
    expect(sent[0]?.options).toEqual({ groupId: "acme-corp/widgets#42", dedupeId: DELIVERY });
  });

  it("maps reopened and unresolved variants", async () => {
    const { app, sent } = setup();
    const reopened = modified("pull_request.opened", (p) => (p.action = "reopened"));
    expect((await deliver(app, reopened)).status).toBe(202);
    const unresolved = modified("pull_request_review_thread.resolved", (p) => {
      p.action = "unresolved";
    });
    expect((await deliver(app, unresolved, { event: "pull_request_review_thread" })).status).toBe(
      202,
    );
    expect(sent.map((s) => s.job.kind)).toEqual(["pr_opened", "thread_unresolved"]);
  });

  it("doesn't put the PR title, body or other payload fields on the queue", async () => {
    const { app, sent } = setup();
    await deliver(app, fixture("pull_request.opened"));
    expect(JSON.stringify(sent[0]?.job)).not.toContain("Retries transient");
  });

  it("accepts application/json with a charset", async () => {
    const { app } = setup();
    const response = await deliver(app, fixture("pull_request.opened"), {
      contentType: "application/json; charset=utf-8",
    });
    expect(response.status).toBe(202);
  });

  it("accepts form-urlencoded deliveries, signed over the form body", async () => {
    const { app, sent } = setup();
    const form = `payload=${encodeURIComponent(fixture("pull_request.opened").toString("utf8"))}`;
    const response = await deliver(app, form, {
      contentType: "application/x-www-form-urlencoded",
    });
    expect(response.status).toBe(202);
    expect(sent[0]?.job.kind).toBe("pr_opened");
  });
});

describe("POST /webhooks/github: signatures", () => {
  it("answers ping with 200 and queues nothing", async () => {
    const { app, send } = setup();
    const response = await deliver(app, fixture("ping"), { event: "ping" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a wrong, missing or malformed signature with the same bare 401", async () => {
    const { app, send } = setup();
    const body = fixture("pull_request.opened");
    const responses = [
      await deliver(app, body, { secret: "not the secret" }),
      await deliver(app, body, { signature: signBody("other body", SECRET) }),
      await deliver(app, body, { signature: undefined }),
      await deliver(app, body, { signature: "sha256=zz" }),
      await deliver(app, body, { signature: signBody(body, SECRET).replace("sha256=", "sha1=") }),
      await deliver(app, body, { signature: signBody(body, SECRET).slice(0, -2) }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("checks the signature before the headers or the JSON", async () => {
    const { app } = setup();
    const response = await deliver(app, "{not json", {
      event: undefined,
      delivery: undefined,
      secret: "wrong",
    });
    expect(response.status).toBe(401);
  });

  it("doesn't look the secret up for a missing or malformed signature", async () => {
    const secrets = rotatingSecrets(SECRET);
    const { app } = setup({ secrets: secrets.store });
    await deliver(app, fixture("pull_request.opened"), { signature: undefined });
    await deliver(app, fixture("pull_request.opened"), { signature: "sha256=nope" });
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("accepts a rotated secret after one refetch", async () => {
    const secrets = rotatingSecrets("old-secret");
    const { app, send } = setup({ secrets: secrets.store });
    secrets.rotate("new-secret");
    const response = await deliver(app, fixture("pull_request.opened"), { secret: "new-secret" });
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(secrets.get.mock.calls).toEqual([[], [{ refresh: true }]]);

    // The fresh secret is now the cached one: no further refreshes.
    secrets.get.mockClear();
    await deliver(app, fixture("pull_request.opened"), { secret: "new-secret" });
    expect(secrets.get.mock.calls).toEqual([[]]);
  });

  it("refetches only once for a forged signature, then gives up", async () => {
    const secrets = rotatingSecrets(SECRET);
    const { app } = setup({ secrets: secrets.store });
    const response = await deliver(app, fixture("pull_request.opened"), { secret: "forged" });
    expect(response.status).toBe(401);
    expect(secrets.get).toHaveBeenCalledTimes(2);
  });
});

describe("POST /webhooks/github: bad requests", () => {
  it("needs X-GitHub-Event and X-GitHub-Delivery", async () => {
    const { app, send } = setup();
    const body = fixture("pull_request.opened");
    const noEvent = await deliver(app, body, { event: undefined });
    expect(noEvent.status).toBe(400);
    expect(noEvent.body).toEqual({ error: "Missing X-GitHub-Event header" });
    for (const delivery of [undefined, "", "../../etc", "x".repeat(129)]) {
      const response = await deliver(app, body, { delivery });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Missing or invalid X-GitHub-Delivery header" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("answers invalid JSON after a valid signature with 400", async () => {
    const { app, send } = setup();
    // (Empty bodies are a 400 too; app.test.ts covers those.)
    for (const body of ["{not json", "payload=", "[1,"]) {
      const response = await deliver(app, body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid payload" });
    }
    const noField = await deliver(app, "other=1", {
      contentType: "application/x-www-form-urlencoded",
    });
    expect(noField.status).toBe(400);
    const badField = await deliver(app, "payload=%7Bnope", {
      contentType: "application/x-www-form-urlencoded",
    });
    expect(badField.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/github: ignored deliveries", () => {
  const cases: [string, string, string | Buffer, string][] = [
    [
      "draft PRs",
      "pull_request",
      modified("pull_request.opened", (p) => (p.pull_request.draft = true)),
      "draft pull request",
    ],
    [
      "bot senders",
      "pull_request",
      modified("pull_request.synchronize", (p) => {
        p.sender = { login: "lgtmoose[bot]", id: 1, type: "Bot" };
      }),
      "bot sender: lgtmoose[bot]",
    ],
    [
      "our own App's comments",
      "issue_comment",
      modified("issue_comment.created", (p) => {
        p.sender = { login: "lgtmoose-reviewer[bot]", id: 2, type: "Bot" };
      }),
      "bot sender: lgtmoose-reviewer[bot]",
    ],
    [
      "PRs labelled skip-lgtmoose",
      "pull_request",
      modified("pull_request.opened", (p) => p.pull_request.labels.push({ name: "skip-lgtmoose" })),
      "labelled skip-lgtmoose",
    ],
    [
      "owners not in allowedOrgs",
      "pull_request",
      modified("pull_request.opened", (p) => {
        p.repository.full_name = "someone-else/widgets";
        p.repository.owner.login = "someone-else";
      }),
      "owner not allowed: someone-else",
    ],
    [
      "comments on plain issues",
      "issue_comment",
      fixture("issue_comment.created.issue"),
      "not a pull request",
    ],
    [
      "unsupported actions",
      "pull_request",
      modified("pull_request.opened", (p) => (p.action = "labeled")),
      "unsupported action: pull_request.labeled",
    ],
    ["unsupported events", "push", '{"ref":"refs/heads/main"}', "unsupported event: push"],
  ];

  it.each(cases)("ignores %s with a reason", async (_name, event, body, reason) => {
    const { app, send } = setup();
    const response = await deliver(app, body, { event });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ignored: reason });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/github: failures", () => {
  it("answers 500 when the queue fails, so GitHub can redeliver, without leaking why", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = setup({
      send: async () => {
        throw new Error("AccessDenied for arn:aws:sqs:us-east-1:123456789012:jobs.fifo");
      },
    });
    const response = await deliver(app, fixture("pull_request.opened"));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(response.text).not.toContain("arn:aws");
    expect(log).toHaveBeenCalled();
  });

  it("answers 500 when the secret can't be read, without leaking why", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secrets: SecretStore = {
      get: async () => {
        throw new Error("ResourceNotFoundException: lgtmoose/github-webhook-secret");
      },
    };
    const { app, send } = setup({ secrets });
    const response = await deliver(app, fixture("pull_request.opened"));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(response.text).not.toContain("ResourceNotFound");
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});

describe("parsePayload", () => {
  it("parses JSON and form bodies, and nothing else", () => {
    const json = Buffer.from('{"a":1}');
    expect(parsePayload(json, "application/json")).toEqual({ payload: { a: 1 } });
    expect(parsePayload(json, undefined)).toEqual({ payload: { a: 1 } });
    const form = Buffer.from(`payload=${encodeURIComponent('{"a":1}')}`);
    expect(parsePayload(form, "Application/X-WWW-Form-Urlencoded; charset=utf-8")).toEqual({
      payload: { a: 1 },
    });
    expect(parsePayload(form, "application/json")).toBeUndefined();
    expect(parsePayload(Buffer.from("{"), "application/json")).toBeUndefined();
  });
});
