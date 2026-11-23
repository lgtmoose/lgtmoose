import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DASHBOARD_CSP } from "@lgtmoose/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { json, type DashboardRequest } from "../dashboard-http.js";
import {
  clientAddress,
  createDashboardServer,
  rateLimiter,
  readSite,
  SECURITY_HEADERS,
} from "./dashboard-server.js";
import { parseOrigin, signingKey } from "./dashboard-setup.js";

let dir: string;
let server: Server;
let base: string;
const seen: DashboardRequest[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgtmoose-dashboard-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>LGTMoose</title>");
  await writeFile(join(dir, "app.js"), "console.log(1);");
  await writeFile(join(dir, "app.css"), "body{}");
  // Never served: only the page's own files are.
  await writeFile(join(dir, "secret.txt"), "nope");
  server = createDashboardServer({
    async handle(request) {
      seen.push(request);
      if (request.path === "/api/boom") throw new Error("boom");
      if (request.path === "/api/me") {
        // A handler can't turn the security headers off.
        const result = json(200, { login: "dev" }, ["a=1; Secure", "b=2; Secure"]);
        return { ...result, headers: { ...result.headers, "x-frame-options": "ALLOWALL" } };
      }
      return json(404, { error: "not-found" });
    },
    site: await readSite(dir),
    trustProxyHops: 1,
    rateLimit: { perSecond: 0.001, burst: 5 },
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
  expect(response.headers.get("strict-transport-security")).toBe(
    "max-age=63072000; includeSubDomains",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("the compose dashboard server", () => {
  it("serves the page's files with the security headers", async () => {
    for (const [path, type] of [
      ["/", "text/html; charset=utf-8"],
      ["/index.html", "text/html; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/app.css", "text/css; charset=utf-8"],
    ] as const) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expectSecurityHeaders(response);
    }
    expect(await (await fetch(`${base}/app.js`)).text()).toBe("console.log(1);");
  });

  it("serves nothing else, with the headers on refusals too", async () => {
    for (const path of ["/secret.txt", "/../secret.txt", "/%2e%2e/secret.txt", "/app.js.map"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("nope");
      expectSecurityHeaders(response);
    }
    const posted = await fetch(`${base}/`, { method: "POST" });
    expect(posted.status).toBe(405);
    expectSecurityHeaders(posted);
  });

  it("hands API requests to the handler, and keeps the security headers its own", async () => {
    const response = await fetch(`${base}/api/me?repo=acme%2Fshop&repo=other`, {
      headers: { cookie: "__Host-lgtmoose_session=token; other=x", origin: "https://dash.test" },
    });
    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual(["a=1; Secure", "b=2; Secure"]);
    const request = seen.at(-1);
    expect(request).toMatchObject({
      method: "GET",
      path: "/api/me",
      query: { repo: "acme/shop" },
      cookies: { "__Host-lgtmoose_session": "token", other: "x" },
    });
    expect(request?.headers.origin).toBe("https://dash.test");
  });

  it("hands an API POST's body to the handler (NIC-1140)", async () => {
    const response = await fetch(`${base}/api/findings/x/ack`, {
      method: "POST",
      body: JSON.stringify({ outcome: "fixed" }),
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    expect(response.status).toBe(404);
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      body: '{"outcome":"fixed"}',
    });
  });

  it("answers an oversized chunked body with 413, without handing it on", async () => {
    const before = seen.length;
    const big = new TextEncoder().encode("x".repeat(20 * 1024));
    const response = await fetch(`${base}/api/findings/x/ack`, {
      method: "POST",
      // A stream: sent chunked, with no Content-Length to refuse it up front.
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(big);
          controller.close();
        },
      }),
      duplex: "half",
      headers: { "x-forwarded-for": "198.51.100.8" },
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(seen.length).toBe(before);
  });

  it("answers 413 to an endless chunked body without reading it to the end", async () => {
    const url = new URL(`${base}/api/findings/x/ack`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.9", "transfer-encoding": "chunked" },
      });
      const chunk = "x".repeat(1024);
      let answered = false;
      // Never ends: only the server's answer stops it.
      const pump = () => {
        if (answered) return;
        req.write(chunk, () => setImmediate(pump));
      };
      req.on("response", (response) => {
        answered = true;
        resolve(response.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", (error) => {
        if (!answered) reject(error);
      });
      pump();
    });
    expect(status).toBe(413);
  });

  it("allows only GET and POST on the API, and answers a handler's failure with 500", async () => {
    const put = await fetch(`${base}/api/me`, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST");
    expectSecurityHeaders(put);
    const failed = await fetch(`${base}/api/boom`, {
      headers: { "x-forwarded-for": "198.51.100.9" },
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "internal" });
    expectSecurityHeaders(failed);
  });

  it("rate-limits API callers by the address the trusted proxy saw", async () => {
    const call = (forwarded: string) =>
      fetch(`${base}/api/none`, { headers: { "x-forwarded-for": forwarded } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await call("203.0.113.7")).status);
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
    // Another caller has its own budget; a spoofed left-hand entry doesn't change the caller.
    expect((await call("203.0.113.8")).status).toBe(404);
    expect((await call("1.2.3.4, 203.0.113.7")).status).toBe(429);
  });
});

describe("clientAddress", () => {
  it("trusts as many hops as it's told", () => {
    expect(clientAddress("10.0.0.2", "1.1.1.1, 2.2.2.2", 0)).toBe("10.0.0.2");
    expect(clientAddress("10.0.0.2", "1.1.1.1, 2.2.2.2", 1)).toBe("2.2.2.2");
    expect(clientAddress("10.0.0.2", "1.1.1.1, 2.2.2.2", 2)).toBe("1.1.1.1");
    expect(clientAddress("10.0.0.2", "1.1.1.1", 5)).toBe("1.1.1.1");
    expect(clientAddress("10.0.0.2", undefined, 1)).toBe("10.0.0.2");
  });
});

describe("rateLimiter", () => {
  it("refills over time", () => {
    let now = 0;
    const allow = rateLimiter(1, 2, () => now);
    expect([allow("a"), allow("a"), allow("a")]).toEqual([true, true, false]);
    now = 1000;
    expect(allow("a")).toBe(true);
  });
});

describe("the dashboard's settings", () => {
  it("takes an https origin only", () => {
    expect(parseOrigin("https://LGTMoose.example.com/")).toBe("https://lgtmoose.example.com");
    expect(parseOrigin("https://dash.example.com:8443")).toBe("https://dash.example.com:8443");
    for (const bad of ["http://dash.example.com", "https://dash.example.com/path", "dash"]) {
      expect(() => parseOrigin(bad), bad).toThrow(/DASHBOARD_ORIGIN/);
    }
  });

  it("generates the signing key once and keeps it", async () => {
    const secrets = await mkdtemp(join(tmpdir(), "lgtmoose-dashboard-secrets-"));
    try {
      const [first, second] = await Promise.all([signingKey(secrets), signingKey(secrets)]);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(second.equals(first)).toBe(true);
      expect((await signingKey(secrets)).equals(first)).toBe(true);
      const file = join(secrets, "lgtmoose__dashboard-signing-key");
      expect((await readFile(file, "utf8")).trim()).toBe(first.toString("utf8"));
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(secrets, { recursive: true, force: true });
    }
  });

  it("keeps the CloudFront headers' names", () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual([
      "content-security-policy",
      "referrer-policy",
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
    ]);
  });
});
