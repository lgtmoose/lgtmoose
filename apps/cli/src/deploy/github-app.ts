import { z } from "zod";
import { GitHubRequestError, githubRequest } from "../github-request.js";

/** A GitHub App JWT, the credential for the /app endpoints. Shared with the control task. */
export { appJwt } from "@lgtmoose/poster";

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

/** Where the App's settings live, for what the API can't change. */
export function appSettingsUrl(app: AppInfo): string {
  const slug = encodeURIComponent(app.slug);
  return app.owner.type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;
}

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
