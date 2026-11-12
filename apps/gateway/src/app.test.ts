import { describe, expect, it } from "vitest";
import { ROUTES, createApp } from "./app.js";

const app = createApp({ version: "1.2.3" });

describe("gateway app", () => {
  it("reports health and version", async () => {
    const response = await app.request(ROUTES.health);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "1.2.3" });
  });

  it("answers webhooks with 501 until NIC-804 lands", async () => {
    const response = await app.request(ROUTES.githubWebhook, { method: "POST", body: "{}" });
    expect(response.status).toBe(501);
  });

  it("returns JSON 404 for unknown paths", async () => {
    const response = await app.request("/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
