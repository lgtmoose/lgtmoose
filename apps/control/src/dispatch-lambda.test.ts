import { afterEach, describe, expect, it, vi } from "vitest";

const databasePool = vi.fn();
vi.mock("./database.js", () => ({ databasePool }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dispatcher handler", () => {
  it("checks its whole environment before it connects to anything", async () => {
    vi.stubEnv("DATABASE_SECRET_ARN", "arn:secret");
    vi.stubEnv("DATABASE_NAME", "lgtmoose");
    vi.stubEnv("STATE_MACHINE_ARN", "");
    vi.stubEnv("DEAD_LETTER_QUEUE_URL", "https://sqs/dlq");
    const { handler } = await import("./dispatch-lambda.js");
    await expect(handler({ Records: [] })).rejects.toThrow(
      "Missing environment variables: STATE_MACHINE_ARN",
    );
    expect(databasePool).not.toHaveBeenCalled();
  });
});
