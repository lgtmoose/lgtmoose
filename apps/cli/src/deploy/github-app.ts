import { createSign } from "node:crypto";
import { z } from "zod";
import { GitHubRequestError, githubRequest } from "../github-request.js";

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

export interface AppInfo {
  id: number;
  slug: string;
  owner: { login: string; type: string };
}

export interface WebhookConfig {
  url: string;
  /** GitHub signs deliveries with this. Written only; GitHub never returns it. Left as is when omitted. */
  secret?: string;
  contentType?: "json";
}

/** The GitHub App calls `deploy` and `destroy` make, authenticated as the App itself. */
export interface GitHubAppApi {
  /** GET /app */
  getApp(jwt: string): Promise<AppInfo>;
  /** PATCH /app/hook/config */
  setWebhook(jwt: string, config: WebhookConfig): Promise<void>;
}

const appSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  owner: z.object({ login: z.string().min(1), type: z.string().min(1) }),
});

export function createGitHubAppApi(
  fetchFn: typeof fetch = fetch,
  apiUrl = "https://api.github.com",
): GitHubAppApi {
  async function call(jwt: string, method: string, path: string, body?: object) {
    try {
      return await githubRequest(fetchFn, apiUrl, method, path, {
        jwt,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 401) {
        throw new Error(
          `${error.message} GitHub rejected the App's private key. Check lgtmoose/github-app, or run setup again.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  return {
    async getApp(jwt) {
      const parsed = appSchema.safeParse(await call(jwt, "GET", "/app"));
      if (!parsed.success)
        throw new Error("GitHub's reply to GET /app was missing expected fields.");
      return parsed.data;
    },
    async setWebhook(jwt, config) {
      await call(jwt, "PATCH", "/app/hook/config", {
        url: config.url,
        ...(config.secret === undefined ? {} : { secret: config.secret }),
        ...(config.contentType === undefined ? {} : { content_type: config.contentType }),
        insecure_ssl: "0",
      });
    },
  };
}
