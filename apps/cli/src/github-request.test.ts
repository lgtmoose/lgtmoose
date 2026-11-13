import { describe, expect, it } from "vitest";
import { GitHubRequestError, githubRequest } from "./github-request.js";

describe("githubRequest", () => {
  it("never puts the one-time manifest code in an error message", async () => {
    const fetchFn = () => Promise.resolve(new Response("{}", { status: 422 }));
    const error = await githubRequest(
      fetchFn,
      "https://api.test",
      "POST",
      "/app-manifests/SECRET-CODE/conversions",
    ).then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(GitHubRequestError);
    expect(error.message).toBe("GitHub POST /app-manifests/<code>/conversions failed (HTTP 422).");
  });
});
