import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { appJwt, appSettingsUrl, createGitHubAppApi } from "./github-app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function decode(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString()) as Record<string, unknown>;
}

describe("appJwt", () => {
  it("signs an RS256 token GitHub accepts: issuer, backdated iat, under ten minutes", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const token = appJwt(42, PEM, now);
    const [header, payload, signature] = token.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    const seconds = now.getTime() / 1000;
    expect(claims).toEqual({ iss: "42", iat: seconds - 60, exp: seconds + 540 });
    const valid = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature ?? "", "base64url");
    expect(valid).toBe(true);
  });
});

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe("createGitHubAppApi", () => {
  it("sends the webhook URL, secret and JSON content type, authenticated as the App", async () => {
    const fetchFn = fakeFetch(200, {});
    await createGitHubAppApi(fetchFn, "https://api.test").setWebhook("JWT", {
      url: "https://abc.execute-api.us-east-1.amazonaws.com/webhooks/github",
      secret: "whsec",
      contentType: "json",
    });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://api.test/app/hook/config");
    expect(init?.method).toBe("PATCH");
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer JWT");
    expect(JSON.parse(init?.body as string)).toEqual({
      url: "https://abc.execute-api.us-east-1.amazonaws.com/webhooks/github",
      secret: "whsec",
      content_type: "json",
      insecure_ssl: "0",
    });
  });

  it("reads the App", async () => {
    const app = { id: 42, slug: "lgtmoose-acme", owner: { login: "acme", type: "Organization" } };
    await expect(createGitHubAppApi(fakeFetch(200, app)).getApp("JWT")).resolves.toEqual(app);
  });

  it("leaves the secret alone when only the URL changes", async () => {
    const fetchFn = fakeFetch(200, {});
    await createGitHubAppApi(fetchFn).setWebhook("JWT", { url: "https://x.test" });
    expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string)).toEqual({
      url: "https://x.test",
      insecure_ssl: "0",
    });
  });

  it("explains a rejected key without echoing the request", async () => {
    const api = createGitHubAppApi(fakeFetch(401, { message: "Bad credentials" }));
    await expect(
      api.setWebhook("JWT", { url: "https://x.test", secret: "whsec-value", contentType: "json" }),
    ).rejects.toThrow(/HTTP 401: Bad credentials\).*private key/);
    await expect(
      api.setWebhook("JWT", { url: "https://x.test", secret: "whsec-value", contentType: "json" }),
    ).rejects.not.toThrow(/whsec-value/);
  });
});

describe("appSettingsUrl", () => {
  it("points at the org's or the user's App settings", () => {
    expect(
      appSettingsUrl({ id: 1, slug: "a", owner: { login: "acme", type: "Organization" } }),
    ).toBe("https://github.com/organizations/acme/settings/apps/a");
    expect(appSettingsUrl({ id: 1, slug: "a", owner: { login: "octo", type: "User" } })).toBe(
      "https://github.com/settings/apps/a",
    );
  });
});
