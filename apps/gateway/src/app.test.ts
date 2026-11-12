import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { errorHandler } from "./middleware/errors.js";
import { MAX_WEBHOOK_BYTES, ROUTES } from "./paths.js";
import { webhooksRouter } from "./routes/webhooks.js";

const app = createApp({ version: "1.2.3" });

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

  it("answers webhooks with 501 until NIC-804 lands", async () => {
    const response = await request(app)
      .post(ROUTES.githubWebhook)
      .set("content-type", "application/json")
      .send('{"action":"opened"}');
    expect(response.status).toBe(501);
  });

  it("doesn't JSON-parse webhook bodies, so signatures can be checked against the raw bytes", async () => {
    // Malformed JSON would be a 400 from express.json(); reaching the handler proves it's raw.
    const response = await request(app)
      .post(ROUTES.githubWebhook)
      .set("content-type", "application/json")
      .send("{not json");
    expect(response.status).toBe(501);
  });

  it("caps webhook payloads at GitHub's 25 MB limit by default", () => {
    expect(MAX_WEBHOOK_BYTES).toBe("25mb");
  });

  it("rejects webhook payloads over the limit with a JSON 413", async () => {
    // A small limit keeps the test fast; createApp always uses GitHub's 25 MB.
    const small = express().use("/webhooks", webhooksRouter(1024)).use(errorHandler);
    const response = await request(small)
      .post(ROUTES.githubWebhook)
      .set("content-type", "application/json")
      .send(Buffer.alloc(2048, "a"));
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "request entity too large" });
  });

  it("answers an empty or missing webhook body with 400, not a logged 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await request(app).post(ROUTES.githubWebhook);
    const empty = await request(app)
      .post(ROUTES.githubWebhook)
      .set("content-type", "application/json")
      .set("content-length", "0");
    for (const response of [missing, empty]) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Empty body" });
    }
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("trusts exactly one proxy hop for the client IP", async () => {
    const trust = createApp({ version: "x" }).get("trust proxy");
    expect(trust).toBe(1);
    // Same setting on a probe app: of a client-supplied address and the one the proxy appended,
    // only the proxy's counts.
    const probe = express().set("trust proxy", trust);
    probe.get("/ip", (req, res) => {
      res.json({ ip: req.ip });
    });
    const response = await request(probe)
      .get("/ip")
      .set("x-forwarded-for", "140.82.112.1, 203.0.113.9");
    expect(response.body).toEqual({ ip: "203.0.113.9" });
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

  it("keeps the status and message of client errors", async () => {
    const error = Object.assign(new Error("bad thing"), { status: 422 });
    const response = await request(appThatThrows(error)).get("/boom");
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: "bad thing" });
  });
});
