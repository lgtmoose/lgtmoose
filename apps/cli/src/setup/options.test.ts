import { describe, expect, it } from "vitest";
import { UsageError, parseSetupFlags, resolveSetupInputs } from "./options.js";
import type { Prompter } from "./prompter.js";

/** Fails the test if setup asks anything. */
const silent: Prompter = {
  input: () => Promise.reject(new Error("unexpected prompt")),
  confirm: () => Promise.reject(new Error("unexpected prompt")),
  select: () => Promise.reject(new Error("unexpected prompt")),
};

describe("parseSetupFlags", () => {
  it("reads every flag", () => {
    expect(
      parseSetupFlags([
        "--org",
        "acme",
        "--app-name",
        "acme reviewer",
        "--region",
        "eu-west-1",
        "--profile",
        "standard",
        "--yes",
      ]),
    ).toEqual({
      owner: { login: "acme", kind: "org" },
      appName: "acme reviewer",
      region: "eu-west-1",
      profile: "standard",
      yes: true,
      help: false,
    });
  });

  it("reads --user as a personal account", () => {
    expect(parseSetupFlags(["--user", "octocat"]).owner).toEqual({
      login: "octocat",
      kind: "user",
    });
  });

  it.each([
    [["--org", "acme", "--user", "octocat"], "either --org or --user"],
    [["--org", "bad_name!"], '--org "bad_name!": use a GitHub org or user'],
    [["--org", "acme", "--region", "mars-1"], "use an AWS region such as us-east-1"],
    [["--org", "acme", "--profile", "huge"], '--profile "huge": use lean or standard'],
    [["--org", "acme", "--app-name", "x".repeat(35)], "at most 34 characters"],
    [["--yes"], "--yes needs --org <name> or --user <name>"],
    [["--frobnicate"], "Unknown option '--frobnicate'"],
    [["acme"], "Unexpected argument 'acme'"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseSetupFlags(argv)).toThrow(UsageError);
    expect(() => parseSetupFlags(argv)).toThrow(message);
  });
});

describe("resolveSetupInputs", () => {
  it("uses defaults with --yes and never prompts", async () => {
    const inputs = await resolveSetupInputs(parseSetupFlags(["--org", "Acme", "--yes"]), silent);
    expect(inputs).toEqual({
      owner: { login: "Acme", kind: "org" },
      appName: "lgtmoose-acme",
      region: "us-east-1",
      profile: "lean",
    });
  });

  it("prompts for anything the flags left out, validating as it goes", async () => {
    const asked: string[] = [];
    const prompter: Prompter = {
      select: (options) => {
        asked.push(options.message);
        const value = options.message.startsWith("Where") ? "user" : "standard";
        return Promise.resolve(value as never);
      },
      input: (options) => {
        asked.push(options.message);
        if (options.message === "GitHub username") {
          expect(options.validate?.("not valid!")).toContain("GitHub org or user");
          return Promise.resolve(" octocat ");
        }
        if (options.message === "AWS region") {
          expect(options.validate?.("nope")).toContain("AWS region");
          return Promise.resolve("ap-southeast-2");
        }
        return Promise.resolve(options.default ?? "");
      },
      confirm: () => Promise.reject(new Error("unexpected confirm")),
    };
    const inputs = await resolveSetupInputs(parseSetupFlags([]), prompter);
    expect(inputs).toEqual({
      owner: { login: "octocat", kind: "user" },
      appName: "lgtmoose-octocat",
      region: "ap-southeast-2",
      profile: "standard",
    });
    expect(asked).toHaveLength(5);
  });
});
