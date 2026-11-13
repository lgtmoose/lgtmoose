import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { errorHandler } from "./middleware/errors.js";
import { MAX_WEBHOOK_BYTES, ROUTES } from "./paths.js";
import type { JobQueue, WebhookSecretSource } from "./ports.js";
import { githubWebhookHandler, webhooksRouter, type WebhookDeps } from "./routes/webhooks.js";
import { signBody } from "./signature.js";

const SECRET = "app-test-secret";

/** Webhook deps that verify against SECRET and queue nothing; webhooks.test.ts covers the flow. */
function testDeps(): WebhookDeps {
  const secrets: WebhookSecretSource = { get: async () => SECRET };
  const queue: JobQueue = { send: vi.fn(async () => {}) };
  return { secrets, queue, allowedOrgs: ["acme-corp"] };
}

const app = createApp({ version: "1.2.3", trustProxyHops: 1 }, testDeps());

describe("gateway app", () => {
  it("reports health and version", async () => {
    const response = await request(app).get(ROUTES.health);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, version: "1.2.3" });
  });

  it("sends security headers and hides the framework", async () => {
    const response = await request(app).get(ROUTES.health);
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["strict-transport-security"]).toBeDefined();
  });

  it("doesn't JSON-parse webhook bodies, so signatures can be checked against the raw bytes", async () => {
    // express.json() would answer malformed JSON with its own 400 before any signature check.
    // A 401 for an unsigned body, and the handler's own 400 for a signed one, prove it's raw.
    const unsigned = await request(app)
      .post(ROUTES.githubWebhook)
      .set("content-type", "application/json")
      .send("{not json");
    expect(unsigned.status).toBe(401);

    const signed = await request(app)
      .post(ROUTES.githubWebhook)
      .set("content-type", "application/json")
      .set("x-hub-signature-256", signBody("{not json", SECRET))
      .set("x-github-event", "pull_request")
      .set("x-github-delivery", "d1")
      .send("{not json");
    expect(signed.status).toBe(400);
    expect(signed.body).toEqual({ error: "Invalid payload" });
  });

  it("caps webhook payloads at GitHub's 25 MB limit by default", () => {
    expect(MAX_WEBHOOK_BYTES).toBe("25mb");
  });

  it("rejects webhook payloads over the limit with a JSON 413", async () => {
    // A small limit keeps the test fast; createApp always uses GitHub's 25 MB.
    const small = express().use("/webhooks", webhooksRouter(testDeps(), 1024)).use(errorHandler);
    const response = await request(small)
      .post(ROUTES.githubWebhook)
      .set("content-type", "application/json")
      .send(Buffer.alloc(2048, "a"));
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "request entity too large" });
  });

  it("answers an empty webhook body with 400, not a logged 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request(app)
      .post(ROUTES.githubWebhook)
      .set("content-type", "application/json")
      .set("content-length", "0");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Empty body" });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("answers a webhook with no body at all (req.body unset) with 400", async () => {
    // express.raw leaves req.body unset when a request has neither Content-Length nor
    // Transfer-Encoding; call the handler directly to cover that case for certain.
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { status } as unknown as Response;
    await githubWebhookHandler(testDeps())({ body: undefined } as Request, res, () => {});
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "Empty body" });
  });

  it("returns JSON 404 for unknown paths and methods", async () => {
    for (const response of [
      await request(app).get("/nope"),
      await request(app).get(ROUTES.githubWebhook),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Not found" });
    }
  });
});

describe("client IP", () => {
  /** The real app's trust setting on a probe app that reports req.ip. */
  async function ipSeen(trustProxyHops: number, forwardedFor: string) {
    const trust = createApp({ version: "x", trustProxyHops }, testDeps()).get("trust proxy");
    const probe = express().set("trust proxy", trust);
    probe.get("/ip", (req, res) => {
      res.json({ ip: req.ip });
    });
    const response = await request(probe).get("/ip").set("x-forwarded-for", forwardedFor);
    return (response.body as { ip: string }).ip;
  }

  it("behind one proxy, uses the address the proxy appended, not the caller's own", async () => {
    expect(await ipSeen(1, "140.82.112.1, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("with no proxy, ignores X-Forwarded-For entirely", async () => {
    const ip = await ipSeen(0, "140.82.112.1");
    expect(ip).not.toBe("140.82.112.1");
    expect(ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it("rejects an invalid hop count", () => {
    for (const trustProxyHops of [-1, 1.5, Number.NaN]) {
      expect(() => createApp({ version: "x", trustProxyHops }, testDeps())).toThrow(
        /trustProxyHops/,
      );
    }
  });
});

describe("errorHandler", () => {
  function appThatThrows(error: Error) {
    const test = express();
    test.get("/boom", async () => {
      throw error;
    });
    test.use(errorHandler);
    return test;
  }

  it("hides internals of server errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request(appThatThrows(new Error("db password is hunter2"))).get("/boom");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(response.body)).not.toContain("hunter2");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("answers JSON 500 when an error carries an invalid status", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [0, "404", 99, 700]) {
      const error = Object.assign(new Error("odd"), { status });
      const response = await request(appThatThrows(error)).get("/boom");
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    }
    log.mockRestore();
  });

  it("shows a client error's message only when it's marked safe to show", async () => {
    const safe = Object.assign(new Error("bad thing"), { status: 422, expose: true });
    expect((await request(appThatThrows(safe)).get("/boom")).body).toEqual({ error: "bad thing" });

    const internal = Object.assign(new Error("Secret arn:aws:secretsmanager:x not found"), {
      status: 404,
    });
    const response = await request(appThatThrows(internal)).get("/boom");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not Found" });
  });
});
