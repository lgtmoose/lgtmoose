import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appJwt, installationTokenProvider } from "./app-auth.js";
import { GitHubError } from "./github.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function fakeFetch(replies: { status: number; body: unknown }[]) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const reply = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("appJwt", () => {
  it("signs a short-lived JWT for the App", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const [, payload] = appJwt(42, PEM, now).split(".");
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({
      iat: now.getTime() / 1000 - 60,
      exp: now.getTime() / 1000 + 540,
      iss: "42",
    });
  });
});

describe("installationTokenProvider", () => {
  it("fetches a token with the App JWT and caches it until near expiry", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { fetchFn, calls } = fakeFetch([
      { status: 201, body: { token: "ghs_one", expires_at: "2026-01-01T01:00:00Z" } },
      { status: 201, body: { token: "ghs_two", expires_at: "2026-01-01T02:00:00Z" } },
    ]);
    const token = installationTokenProvider({
      appId: 42,
      privateKey: PEM,
      installationId: 7,
      apiUrl: "https://api.test/",
      fetch: fetchFn,
      now: () => now,
    });
    expect(await token()).toBe("ghs_one");
    expect(await token()).toBe("ghs_one");
    now = new Date("2026-01-01T00:56:00Z");
    expect(await token()).toBe("ghs_two");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/app/installations/7/access_tokens",
      "https://api.test/app/installations/7/access_tokens",
    ]);
    expect(calls[0]?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("gives up on a token request that takes longer than its timeout", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const token = installationTokenProvider({
      appId: 42,
      privateKey: PEM,
      installationId: 7,
      fetch: hang,
      timeoutMs: 20,
    });
    await expect(token()).rejects.toThrow();
  });

  it("throws GitHub's reason without the JWT", async () => {
    const { fetchFn } = fakeFetch([{ status: 404, body: { message: "Not Found" } }]);
    const token = installationTokenProvider({
      appId: 42,
      privateKey: PEM,
      installationId: 7,
      fetch: fetchFn,
    });
    const error = await token().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(String(error)).toContain("HTTP 404: Not Found");
    expect(String(error)).not.toContain("Bearer");
  });
});
