import { describe, expect, it, vi } from "vitest";
import { createGitHubApi } from "./github.js";

const conversion = {
  id: 42,
  slug: "lgtmoose-acme",
  name: "lgtmoose-acme",
  html_url: "https://github.com/apps/lgtmoose-acme",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  webhook_secret: "whsec-fake",
  client_id: "Iv1.fake",
  client_secret: "client-secret-fake",
  owner: { login: "acme" },
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe("createGitHubApi", () => {
  it("converts the code with an unauthenticated POST", async () => {
    const fetchFn = fakeFetch(201, conversion);
    const app = await createGitHubApi(fetchFn).convertManifest("abc123");
    expect(app).toEqual({
      id: 42,
      slug: "lgtmoose-acme",
      name: "lgtmoose-acme",
      htmlUrl: "https://github.com/apps/lgtmoose-acme",
      pem: conversion.pem,
      webhookSecret: "whsec-fake",
      clientId: "Iv1.fake",
      clientSecret: "client-secret-fake",
    });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/app-manifests/abc123/conversions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ accept: "application/vnd.github+json" });
    expect(init?.headers).not.toHaveProperty("authorization");
  });

  it("treats a missing webhook secret as null", async () => {
    const fetchFn = fakeFetch(201, { ...conversion, webhook_secret: null });
    const app = await createGitHubApi(fetchFn).convertManifest("abc123");
    expect(app.webhookSecret).toBeNull();
  });

  it("explains an expired or reused code", async () => {
    const fetchFn = fakeFetch(404, { message: "Not Found" });
    await expect(createGitHubApi(fetchFn).convertManifest("abc123")).rejects.toThrow(
      /HTTP 404: Not Found.*expires after an hour/,
    );
  });

  it("doesn't echo a malformed reply, which may hold the private key", async () => {
    const fetchFn = fakeFetch(201, { pem: conversion.pem });
    const error = await createGitHubApi(fetchFn)
      .convertManifest("abc123")
      .then(
        () => new Error("expected a rejection"),
        (caught: unknown) => caught as Error,
      );
    expect(error.message).toContain("missing expected fields");
    expect(error.message).not.toContain("PRIVATE KEY");
  });

  it("refuses a code that could change the URL path", async () => {
    const fetchFn = fakeFetch(201, conversion);
    await expect(createGitHubApi(fetchFn).convertManifest("../../user")).rejects.toThrow(
      "malformed",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
