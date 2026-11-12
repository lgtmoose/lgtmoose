/** GitHub said no. `message` is GitHub's short reason; error bodies never hold credentials. */
export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly githubMessage: string | undefined,
    method: string,
    path: string,
  ) {
    // The manifest conversion's path holds a one-time code that can be redeemed for the App's
    // private key, so it never goes into a message.
    const shown = path.replace(/^\/app-manifests\/[^/]+/, "/app-manifests/<code>");
    super(
      `GitHub ${method} ${shown} failed (HTTP ${status}${githubMessage ? `: ${githubMessage}` : ""}).`,
    );
    this.name = "GitHubRequestError";
  }
}

/** One GitHub REST call with the headers every CLI command sends. Resolves to the JSON body. */
export async function githubRequest(
  fetchFn: typeof fetch,
  apiUrl: string,
  method: string,
  path: string,
  options: { jwt?: string; body?: object } = {},
): Promise<unknown> {
  const response = await fetchFn(`${apiUrl}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "lgtmoose-cli",
      ...(options.jwt === undefined ? {} : { authorization: `Bearer ${options.jwt}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const reply = (await response.json().catch(() => ({}))) as { message?: unknown };
    throw new GitHubRequestError(
      response.status,
      typeof reply.message === "string" ? reply.message : undefined,
      method,
      path,
    );
  }
  return response.json().catch(() => ({}));
}
