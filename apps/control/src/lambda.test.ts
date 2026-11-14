import { afterEach, describe, expect, it, vi } from "vitest";
import { presignerCredentials, resetPresignerCredentials } from "./lambda.js";

const ROLE = "arn:aws:iam::123456789012:role/presigner";

function credentials(expiresAtMs: number) {
  return {
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiration: new Date(expiresAtMs),
  };
}

afterEach(() => resetPresignerCredentials());

describe("presignerCredentials", () => {
  it("assumes the role and reuses the session while it outlives a new URL", async () => {
    const assume = vi.fn(async () => credentials(3_600_000));
    await presignerCredentials(ROLE, 3600, 2700, assume, () => 0);
    await presignerCredentials(ROLE, 3600, 2700, assume, () => 600_000);
    expect(assume).toHaveBeenCalledTimes(1);
    expect(assume).toHaveBeenCalledWith({ roleArn: ROLE, sessionSeconds: 3600 });
  });

  it("assumes it again when too little of the session is left for a URL's TTL", async () => {
    const assume = vi.fn(async () => credentials(3_600_000));
    await presignerCredentials(ROLE, 3600, 2700, assume, () => 0);
    // 15 minutes left: a 45-minute URL signed now would stop working early.
    await presignerCredentials(ROLE, 3600, 2700, assume, () => 2_700_000);
    expect(assume).toHaveBeenCalledTimes(2);
  });

  it("refuses a TTL the session can't cover", async () => {
    const assume = vi.fn(async () => credentials(3_600_000));
    await expect(presignerCredentials(ROLE, 3600, 3600, assume, () => 0)).rejects.toThrow(
      "can't be signed",
    );
    expect(assume).not.toHaveBeenCalled();
  });
});
