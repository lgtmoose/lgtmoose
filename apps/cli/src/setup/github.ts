import { GitHubRequestError, githubRequest } from "../github-request.js";
import { z } from "zod";

/** What GitHub hands back once, when the manifest code is converted. Holds secrets. */
export interface CreatedApp {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  pem: string;
  /** GitHub may leave this empty when the manifest's webhook is inactive. */
  webhookSecret: string | null;
  clientId: string;
  clientSecret: string;
}

export interface GitHubApi {
  /** POST /app-manifests/{code}/conversions. The code works once and expires after an hour. */
  convertManifest(code: string): Promise<CreatedApp>;
}

const conversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  html_url: z.string().url(),
  pem: z.string().min(1),
  webhook_secret: z.string().min(1).nullable().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

/** The temporary code GitHub puts on the redirect. Checked before it goes into a URL path. */
export const MANIFEST_CODE = /^[A-Za-z0-9_-]{1,256}$/;

export function createGitHubApi(
  fetchFn: typeof fetch = fetch,
  apiUrl = "https://api.github.com",
): GitHubApi {
  return {
    async convertManifest(code) {
      if (!MANIFEST_CODE.test(code)) throw new Error("GitHub sent a malformed manifest code.");
      // No auth: the one-time code is the credential for this call.
      let reply: unknown;
      try {
        reply = await githubRequest(fetchFn, apiUrl, "POST", `/app-manifests/${code}/conversions`);
      } catch (error) {
        if (!(error instanceof GitHubRequestError)) throw error;
        const detail = error.githubMessage ? `: ${error.githubMessage}` : "";
        throw new Error(
          `GitHub couldn't finish creating the App (HTTP ${error.status}${detail}). ` +
            "The code from GitHub works once and expires after an hour, so run setup again.",
          { cause: error },
        );
      }
      const parsed = conversionSchema.safeParse(reply);
      if (!parsed.success) {
        // Don't echo the body: it holds the private key.
        throw new Error("GitHub's reply to the manifest conversion was missing expected fields.");
      }
      const app = parsed.data;
      return {
        id: app.id,
        slug: app.slug,
        name: app.name,
        htmlUrl: app.html_url,
        pem: app.pem,
        webhookSecret: app.webhook_secret ?? null,
        clientId: app.client_id,
        clientSecret: app.client_secret,
      };
    },
  };
}
