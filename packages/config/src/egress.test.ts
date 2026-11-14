import { describe, expect, it } from "vitest";
import { parseDeployConfig } from "./deploy.js";
import { egressAllowlist } from "./egress.js";

const base = { allowedOrgs: ["acme"], region: "eu-west-2" };

describe("egressAllowlist", () => {
  it("lists the model APIs of the enabled providers, sorted and deduplicated", () => {
    const config = parseDeployConfig({
      ...base,
      providers: [
        { id: "claude", harness: "claude-code", auth: "oauth-token" },
        { id: "sdk", harness: "agent-sdk", auth: "api-key" },
        { id: "codex", harness: "codex", auth: "chatgpt-login" },
      ],
    });
    expect(egressAllowlist(config)).toEqual([
      "api.anthropic.com",
      "auth.openai.com",
      "chatgpt.com",
    ]);
  });

  it("fills in the region for Bedrock", () => {
    const config = parseDeployConfig({
      ...base,
      providers: [{ id: "bedrock", harness: "claude-code", auth: "bedrock" }],
    });
    expect(egressAllowlist(config)).toEqual([
      "bedrock-runtime.eu-west-2.amazonaws.com",
      "bedrock.eu-west-2.amazonaws.com",
    ]);
  });

  it("uses the Vertex host for the provider's region", () => {
    const hosts = (region?: string) =>
      egressAllowlist(
        parseDeployConfig({
          ...base,
          providers: [
            {
              id: "vertex",
              harness: "agent-sdk",
              auth: "vertex",
              ...(region === undefined ? {} : { vertex: { region } }),
            },
          ],
        }),
      );
    expect(hosts()).toEqual(["aiplatform.googleapis.com", "oauth2.googleapis.com"]);
    expect(hosts("eu")).toEqual(["aiplatform.eu.rep.googleapis.com", "oauth2.googleapis.com"]);
    expect(hosts("us-east5")).toEqual([
      "oauth2.googleapis.com",
      "us-east5-aiplatform.googleapis.com",
    ]);
  });

  it("adds extraEgressHosts", () => {
    const config = parseDeployConfig({
      ...base,
      providers: [{ id: "vertex", harness: "claude-code", auth: "vertex" }],
      extraEgressHosts: ["us-east5-aiplatform.googleapis.com", "aiplatform.googleapis.com"],
    });
    expect(egressAllowlist(config)).toEqual([
      "aiplatform.googleapis.com",
      "oauth2.googleapis.com",
      "us-east5-aiplatform.googleapis.com",
    ]);
  });

  it("allows Cursor's API and agent hosts for a cursor-agent provider", () => {
    const config = parseDeployConfig({
      ...base,
      providers: [{ id: "c", harness: "cursor-agent", auth: "service-account" }],
    });
    expect(egressAllowlist(config)).toEqual(["api2.cursor.sh", "api5.cursor.sh"]);
  });

  it("never includes GitHub", () => {
    const config = parseDeployConfig({
      ...base,
      providers: [
        { id: "a", harness: "claude-code", auth: "api-key" },
        { id: "b", harness: "codex", auth: "api-key" },
        { id: "c", harness: "cursor-agent", auth: "api-key" },
      ],
    });
    expect(egressAllowlist(config).some((host) => host.includes("github"))).toBe(false);
  });
});
