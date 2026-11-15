import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HTTP plumbing for the dashboard API (NIC-840): API Gateway HTTP API (payload 2.0) events in and
 * out, cookies, and the signed values the sign-in flow keeps in the browser.
 */

/** A request, as the dashboard handler sees it. Header names are lower case. */
export interface DashboardRequest {
  method: string;
  path: string;
  query: Readonly<Record<string, string | undefined>>;
  headers: Readonly<Record<string, string | undefined>>;
  cookies: Readonly<Record<string, string>>;
}

export interface DashboardResponse {
  status: number;
  headers: Record<string, string>;
  /** Set-Cookie values. */
  cookies: string[];
  body: string;
}

/** The parts of an HTTP API payload 2.0 event the dashboard reads. */
export interface HttpApiEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  queryStringParameters?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
}

export interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
}

/** Cookies from the event's `cookies` (HTTP API) or a `cookie` header. The first of a name wins. */
export function parseCookies(values: readonly string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const value of values) {
    for (const part of value.split(";")) {
      const at = part.indexOf("=");
      if (at <= 0) continue;
      const name = part.slice(0, at).trim();
      if (name === "" || Object.hasOwn(cookies, name)) continue;
      cookies[name] = part.slice(at + 1).trim();
    }
  }
  return cookies;
}

export function fromHttpApiEvent(event: HttpApiEvent): DashboardRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  const cookieValues = [...(event.cookies ?? []), ...(headers.cookie ? [headers.cookie] : [])];
  return {
    method: (event.requestContext?.http?.method ?? "GET").toUpperCase(),
    path: event.rawPath ?? "/",
    query: event.queryStringParameters ?? {},
    headers,
    cookies: parseCookies(cookieValues),
  };
}

export function toHttpApiResult(response: DashboardResponse): HttpApiResult {
  return {
    statusCode: response.status,
    headers: response.headers,
    cookies: response.cookies,
    body: response.body,
  };
}

/** Never cached, by the browser or CloudFront: every answer is about the signed-in person. */
const NO_STORE = { "cache-control": "no-store" };

export function json(status: number, value: unknown, cookies: string[] = []): DashboardResponse {
  return {
    status,
    headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
    cookies,
    body: JSON.stringify(value),
  };
}

export function redirect(location: string, cookies: string[] = []): DashboardResponse {
  return { status: 302, headers: { ...NO_STORE, location }, cookies, body: "" };
}

export function empty(status: number, cookies: string[] = []): DashboardResponse {
  return { status, headers: NO_STORE, cookies, body: "" };
}

/**
 * The session cookie. `__Host-` makes browsers refuse it unless it's Secure, has Path=/ and no
 * Domain, so only the dashboard's own origin ever gets it.
 */
export const SESSION_COOKIE = "__Host-lgtmoose_session";
/** The sign-in's state and PKCE verifier, between leaving for GitHub and coming back. */
export const SIGN_IN_COOKIE = "__Host-lgtmoose_signin";

/**
 * A cookie only the dashboard's own scripts can't read (HttpOnly) and other sites' requests don't
 * carry (SameSite=Lax: sent on top-level navigation back from GitHub, never on a cross-site POST).
 */
export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return setCookie(name, "", 0);
}

/** A random token for a cookie: 32 bytes, base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** PKCE (RFC 7636) S256: the challenge sent to GitHub for a verifier kept in the sign-in cookie. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** `payload.signature`, both base64url: tamper-evident, not secret. */
export function sign(key: Buffer, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** The value `sign` signed with `key`, or undefined if it was changed or isn't one. */
export function verify(key: Buffer, signed: string | undefined): unknown {
  if (signed === undefined) return undefined;
  const dot = signed.indexOf(".");
  if (dot <= 0) return undefined;
  const payload = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", key).update(payload).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether two strings are equal, in time that doesn't depend on where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
