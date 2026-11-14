import { afterEach, describe, expect, it, vi } from "vitest";

const databasePool = vi.fn();
const readSecret = vi.fn();
const parseSecret = vi.fn();
vi.mock("./database.js", () => ({ databasePool, readSecret, parseSecret }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reconciler handler", () => {
  it("checks its whole environment before it reads a secret or connects", async () => {
    vi.stubEnv("JOB_QUEUE_URL", "https://sqs/jobs.fifo");
    vi.stubEnv("DATABASE_SECRET_ARN", "arn:db");
    vi.stubEnv("DATABASE_NAME", "lgtmoose");
    vi.stubEnv("GITHUB_APP_SECRET_ARN", "");
    vi.stubEnv("ALLOWED_ORGS", "acme");
    const { handler } = await import("./reconcile-lambda.js");
    await expect(handler()).rejects.toThrow("Missing environment variables: GITHUB_APP_SECRET_ARN");
    expect(readSecret).not.toHaveBeenCalled();
    expect(databasePool).not.toHaveBeenCalled();
  });
});
