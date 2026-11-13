import { describe, expect, it } from "vitest";
import { HarnessError } from "../harness.js";
import { authJsonSecrets, codexAuth } from "./auth.js";

const AUTH = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id-token-value",
    access_token: "access-value",
    refresh_token: "refresh-value",
    account_id: "acct",
  },
  last_refresh: "2026-11-01T00:00:00Z",
});

describe("codexAuth", () => {
  it("prefers a ChatGPT sign-in, then an access token, then an API key", () => {
    const all = { CODEX_AUTH_JSON: AUTH, CODEX_ACCESS_TOKEN: "tok", OPENAI_API_KEY: "sk" };
    expect(codexAuth(all)).toMatchObject({ method: "chatgpt-login", env: {}, authJson: AUTH });
    expect(codexAuth({ CODEX_ACCESS_TOKEN: "tok", OPENAI_API_KEY: "sk" })).toEqual({
      method: "access-token",
      env: { CODEX_ACCESS_TOKEN: "tok" },
      secrets: ["tok"],
    });
    expect(codexAuth({ OPENAI_API_KEY: "sk" })).toEqual({
      method: "api-key",
      env: { CODEX_API_KEY: "sk" },
      secrets: ["sk"],
    });
    expect(codexAuth({ CODEX_API_KEY: "ck", OPENAI_API_KEY: "sk" }).env).toEqual({
      CODEX_API_KEY: "ck",
    });
  });

  it("collects the sign-in's tokens as secrets, not the account id", () => {
    expect(codexAuth({ CODEX_AUTH_JSON: AUTH }).secrets.sort()).toEqual(
      ["access-value", "id-token-value", "refresh-value"].sort(),
    );
    expect(authJsonSecrets("not json")).toEqual([]);
  });

  it("fails with auth when there's no credential or the auth.json is broken", () => {
    expect(() => codexAuth({})).toThrow(HarnessError);
    expect(() => codexAuth({ CODEX_AUTH_JSON: "{oops" })).toThrow("isn't valid JSON");
  });
});
