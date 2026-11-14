import { createSign } from "node:crypto";
import { z } from "zod";
import { GitHubError, type TokenProvider } from "./github.js";

/**
 * A GitHub App JWT (RS256), the credential for the /app endpoints. GitHub accepts at most ten
 * minutes; `iat` is backdated a minute to allow for clock drift.
 */
export function appJwt(appId: number, privateKey: string, now: Date = new Date()): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: seconds - 60,
    exp: seconds + 9 * 60,
    iss: String(appId),
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

export interface InstallationTokenOptions {
  appId: number;
  privateKey: string;
  installationId: number;
  /** Defaults to https://api.github.com. */
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const tokenReply = z.object({ token: z.string().min(1), expires_at: z.string() });

/** A fresh token is fetched when the cached one has less than this left. */
const REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * Installation access tokens for one installation, as a `TokenProvider`: fetched with an App JWT
 * and cached until five minutes before they expire (they last an hour). Errors never include
 * the private key, the JWT or a token.
 */
export function installationTokenProvider(options: InstallationTokenOptions): TokenProvider {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    const at = now();
    if (cached !== undefined && cached.expiresAt - at.getTime() > REFRESH_BEFORE_MS) {
      return cached.token;
    }
    const path = `/app/installations/${options.installationId}/access_tokens`;
    const response = await fetchFn(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "lgtmoose",
        authorization: `Bearer ${appJwt(options.appId, options.privateKey, at)}`,
      },
    });
    if (!response.ok) {
      const reply = (await response.json().catch(() => ({}))) as { message?: unknown };
      const message = typeof reply.message === "string" ? reply.message.slice(0, 300) : undefined;
      throw new GitHubError(response.status, message, "POST", path);
    }
    const reply = tokenReply.parse(await response.json());
    cached = { token: reply.token, expiresAt: Date.parse(reply.expires_at) };
    return reply.token;
  };
}
