import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DASHBOARD_CSP } from "@lgtmoose/config";
import {
  json,
  parseCookies,
  type DashboardRequest,
  type DashboardResponse,
} from "../dashboard-http.js";

/**
 * The dashboard under docker compose (NIC-1056): one Node HTTP server for the static page and
 * the dashboard API, on one origin behind the operator's reverse proxy, as CloudFront serves
 * both on AWS. The API is the AWS dashboard's own handler (`handleDashboardRequest`); this adds
 * what CloudFront and API Gateway add there: the security headers on every response, the static
 * files, only GET and POST on the API, and a per-client rate limit.
 */

/** What CloudFront's response headers policy sends on AWS (infra/cdk/lib/dashboard-stack.ts). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": DASHBOARD_CSP,
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** The page's files (apps/dashboard's build), by path. Nothing else is served. */
const SITE_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

export type Site = ReadonlyMap<string, { body: Buffer; type: string }>;

/** Reads the built page from `dir` once, at start. */
export async function readSite(dir: string): Promise<Site> {
  const site = new Map<string, { body: Buffer; type: string }>();
  for (const [path, { file, type }] of Object.entries(SITE_FILES)) {
    site.set(path, { body: await readFile(join(dir, file)), type });
  }
  return site;
}

/**
 * The caller's address: with `hops` trusted proxies in front, the one the last of them saw,
 * from the right of `X-Forwarded-For`; with 0, the connection's own. As Express's `trust proxy`
 * with a hop count, so the gateway and the dashboard read TRUST_PROXY_HOPS alike.
 */
export function clientAddress(
  remote: string | undefined,
  forwardedFor: string | undefined,
  hops: number,
): string {
  const chain = [
    ...(forwardedFor ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
    remote ?? "",
  ];
  return chain[Math.max(0, chain.length - 1 - hops)] ?? "";
}

/** A token bucket per caller: API Gateway's stage throttle on AWS, per address here. */
export function rateLimiter(perSecond: number, burst: number, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string): boolean => {
    const at = now();
    const bucket = buckets.get(key) ?? { tokens: burst, at };
    bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.at) / 1000) * perSecond);
    bucket.at = at;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    buckets.set(key, bucket);
    // Full buckets are the default: dropping them keeps the map to recent callers.
    if (buckets.size > 10_000) {
      for (const [name, held] of buckets) {
        if (held.tokens + ((at - held.at) / 1000) * perSecond >= burst) buckets.delete(name);
      }
    }
    return allowed;
  };
}

export interface DashboardServerOptions {
  /** The dashboard API: `handleDashboardRequest` with its dependencies. */
  handle(request: DashboardRequest): Promise<DashboardResponse>;
  site: Site;
  /** Proxies in front that append to X-Forwarded-For (TRUST_PROXY_HOPS). */
  trustProxyHops: number;
  /** API requests per second per caller, and the burst; 10 and 20, as on AWS, by default. */
  rateLimit?: { perSecond: number; burst: number };
  log(message: string, fields?: Record<string, unknown>): void;
}

/** The largest request body taken: the API reads none. */
const MAX_BODY_BYTES = 16 * 1024;

function send(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
  head = false,
  cookies: readonly string[] = [],
): void {
  response.statusCode = status;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  // Last, so a handler's headers can't weaken them.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  if (cookies.length > 0) response.setHeader("set-cookie", [...cookies]);
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(head ? undefined : body);
}

function sendResult(response: ServerResponse, result: DashboardResponse): void {
  send(response, result.status, result.headers, result.body, false, result.cookies);
}

/**
 * A request's body as text, at most `MAX_BODY_BYTES` (NIC-1140: an answer to a finding);
 * undefined when it's longer, which the handler then refuses.
 */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  // Read to the end, keeping at most MAX_BODY_BYTES: a longer (chunked) body is drained, not
  // cut off, so the client gets its 413 rather than a reset connection.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size <= MAX_BODY_BYTES) chunks.push(buffer);
    });
    request.on("end", () =>
      resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString("utf8")),
    );
    request.on("error", reject);
  });
}

/** The request as the dashboard handler takes it: lower-case headers, the first of a value. */
export function toDashboardRequest(
  request: IncomingMessage,
  url: URL,
  body?: string,
): DashboardRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (!Object.hasOwn(query, name)) query[name] = value;
  }
  return {
    method: (request.method ?? "GET").toUpperCase(),
    path: url.pathname,
    query,
    headers,
    cookies: parseCookies(headers.cookie === undefined ? [] : [headers.cookie]),
    ...(body === undefined ? {} : { body }),
  };
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  const limited = rateLimiter(options.rateLimit?.perSecond ?? 10, options.rateLimit?.burst ?? 20);

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const url = new URL(request.url ?? "/", "http://dashboard.invalid");
    const length = Number(request.headers["content-length"] ?? 0);
    if (!Number.isFinite(length) || length > MAX_BODY_BYTES) {
      sendResult(response, json(413, { error: "too-large" }));
      request.destroy();
      return;
    }
    const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
    // Only an API POST reads its body (an answer to a finding, NIC-1140), and only once the
    // caller is within the rate limit; everything else is drained.
    if (!(api && method === "POST")) request.resume();

    if (api) {
      if (method !== "GET" && method !== "POST") {
        const result = json(405, { error: "method" });
        sendResult(response, { ...result, headers: { ...result.headers, allow: "GET, POST" } });
        return;
      }
      const caller = clientAddress(
        request.socket.remoteAddress,
        request.headers["x-forwarded-for"] as string | undefined,
        options.trustProxyHops,
      );
      if (!limited(caller)) {
        if (method === "POST") request.resume();
        sendResult(response, json(429, { error: "slow-down" }));
        return;
      }
      const body = method === "POST" ? await readBody(request) : undefined;
      if (method === "POST" && body === undefined) {
        sendResult(response, json(413, { error: "too-large" }));
        return;
      }
      sendResult(response, await options.handle(toDashboardRequest(request, url, body)));
      return;
    }

    const file = options.site.get(url.pathname);
    if (file === undefined || (method !== "GET" && method !== "HEAD")) {
      send(
        response,
        file === undefined ? 404 : 405,
        {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          ...(file === undefined ? {} : { allow: "GET, HEAD" }),
        },
        file === undefined ? "Not found" : "Method not allowed",
      );
      return;
    }
    send(
      response,
      200,
      // Not content-hashed: the browser checks for a new build on each load.
      { "content-type": file.type, "cache-control": "no-cache" },
      file.body,
      method === "HEAD",
    );
  }

  const server = createServer((request, response) => {
    serve(request, response).catch((error: unknown) => {
      options.log("dashboard request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) sendResult(response, json(500, { error: "internal" }));
      else response.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}
