import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessError } from "../harness.js";
import { claudeAuthEnv } from "./auth.js";
import { prepareClaudeSession } from "./session.js";

const key = JSON.stringify({
  type: "service_account",
  client_email: "reviewer@acme-reviews.iam.gserviceaccount.com",
  project_id: "acme-reviews",
  private_key: "-----BEGIN PRIVATE KEY-----\nKEYMATERIAL\n-----END PRIVATE KEY-----\n",
});

describe("claudeAuthEnv with an inline Vertex key", () => {
  it("takes the project from the key and keeps the key out of the environment", () => {
    const auth = claudeAuthEnv({
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "global",
      GOOGLE_APPLICATION_CREDENTIALS: "/somewhere/else.json",
      GOOGLE_APPLICATION_CREDENTIALS_JSON: key,
    });
    expect(auth.method).toBe("vertex");
    expect(auth.googleCredentials).toBe(key);
    expect(auth.env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("acme-reviews");
    expect(auth.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(auth.env).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS_JSON");
    // The whole key and its private key, raw and JSON-escaped, are redacted.
    expect(auth.secrets).toEqual(
      expect.arrayContaining([
        key,
        "-----BEGIN PRIVATE KEY-----\nKEYMATERIAL\n-----END PRIVATE KEY-----\n",
        "-----BEGIN PRIVATE KEY-----\\nKEYMATERIAL\\n-----END PRIVATE KEY-----\\n",
      ]),
    );
  });

  it("keeps a configured project over the key's", () => {
    const auth = claudeAuthEnv({
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "us-east5",
      ANTHROPIC_VERTEX_PROJECT_ID: "other-project",
      GOOGLE_APPLICATION_CREDENTIALS_JSON: key,
    });
    expect(auth.env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("other-project");
  });

  it("refuses a key that isn't JSON, without quoting it", () => {
    let error: unknown;
    try {
      claudeAuthEnv({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: "global",
        GOOGLE_APPLICATION_CREDENTIALS_JSON: "not-json-SECRET",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).kind).toBe("auth");
    expect(String(error)).not.toContain("SECRET");
  });
});

describe("prepareClaudeSession", () => {
  it("writes the inline key into the run's home with mode 0600", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-session-test-"));
    try {
      const auth = claudeAuthEnv({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: "global",
        GOOGLE_APPLICATION_CREDENTIALS_JSON: key,
      });
      const session = await prepareClaudeSession(home, { PATH: "/bin" }, auth);
      const path = session.env.GOOGLE_APPLICATION_CREDENTIALS;
      expect(path).toBe(join(home, "google-credentials.json"));
      expect((await stat(path!)).mode & 0o777).toBe(0o600);
      expect(await readFile(path!, "utf8")).toBe(key);
      expect(session.env.CLAUDE_CODE_USE_VERTEX).toBe("1");
      expect(JSON.stringify(session.env)).not.toContain("KEYMATERIAL");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
