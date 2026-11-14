/** Gives the token for each request: an installation token, refreshed by the caller as needed. */
export type TokenProvider = () => Promise<string>;

export interface GitHubClientOptions {
  /** Defaults to https://api.github.com. GitHub Enterprise: https://HOST/api/v3. */
  apiUrl?: string;
  token: TokenProvider;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Gives up on a request after this long (an AbortSignal timeout). No limit by default. */
  timeoutMs?: number;
}

/** GitHub said no. `githubMessage` is GitHub's short reason; it never holds the token. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly githubMessage: string | undefined,
    readonly method: string,
    readonly path: string,
  ) {
    super(
      `GitHub ${method} ${path} failed (HTTP ${status}${githubMessage === undefined ? "" : `: ${githubMessage}`}).`,
    );
    this.name = "GitHubError";
  }
}

/** Longest GitHub error message kept, so a large error body can't flood a log line. */
const MESSAGE_LIMIT = 300;

/** Removes the token from a message. A short or empty token isn't one, and isn't searched for. */
function redactToken(message: string, token: string): string {
  return token.length >= 8 ? message.split(token).join("***") : message;
}

/** Items per page for list endpoints; GitHub's maximum. */
const PAGE_SIZE = 100;

/** A small GitHub REST client: JSON in and out, the standard headers, typed errors. */
export class GitHubClient {
  private readonly apiUrl: string;
  private readonly token: TokenProvider;
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly timeoutMs: number | undefined;

  constructor(options: GitHubClientOptions) {
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.token = options.token;
    this.fetchFn = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? "lgtmoose";
    this.timeoutMs = options.timeoutMs;
  }

  async request<T = unknown>(method: string, path: string, body?: object): Promise<T> {
    const token = await this.token();
    const response = await this.fetchFn(`${this.apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": this.userAgent,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(this.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(this.timeoutMs) }),
    });
    if (!response.ok) {
      const reply = (await response.json().catch(() => ({}))) as { message?: unknown };
      const message =
        typeof reply.message === "string" && reply.message !== ""
          ? redactToken(reply.message, token).slice(0, MESSAGE_LIMIT)
          : undefined;
      throw new GitHubError(response.status, message, method, path);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json().catch(() => undefined)) as T;
  }

  /** Every item of a paginated list endpoint, a page of 100 at a time until a short page. */
  async list<T>(
    path: string,
    pick: (page: unknown) => readonly T[] = (page) => (Array.isArray(page) ? (page as T[]) : []),
  ): Promise<T[]> {
    const items: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page += 1) {
      const batch = pick(
        await this.request("GET", `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`),
      );
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return items;
    }
  }
}

/** A PR in a repository. */
export interface PullRef {
  owner: string;
  repo: string;
  pull: number;
}

/** `/repos/owner/repo`, with both parts encoded. */
export function repoPath(ref: Pick<PullRef, "owner" | "repo">): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}
