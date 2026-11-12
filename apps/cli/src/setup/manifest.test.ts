import { describe, expect, it } from "vitest";
import {
  APP_EVENTS,
  MAX_APP_NAME_LENGTH,
  PLACEHOLDER_WEBHOOK_URL,
  buildManifest,
  defaultAppName,
  installUrl,
  newAppUrl,
} from "./manifest.js";

const redirectUrl = "http://127.0.0.1:4567/callback";

describe("buildManifest", () => {
  it("asks for least-privilege permissions and the review events", () => {
    const manifest = buildManifest({
      name: "lgtmoose-acme",
      owner: { login: "acme", kind: "org" },
      redirectUrl,
    });
    expect(manifest.default_permissions).toEqual({
      contents: "read",
      metadata: "read",
      members: "read",
      pull_requests: "write",
      issues: "write",
      checks: "write",
    });
    expect(manifest.default_events).toEqual([
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "pull_request_review_thread",
      "issue_comment",
    ]);
    expect(manifest.default_events).toEqual([...APP_EVENTS]);
  });

  it("is private, redirects locally and leaves the webhook off until deploy", () => {
    const manifest = buildManifest({
      name: "lgtmoose-acme",
      owner: { login: "acme", kind: "org" },
      redirectUrl,
    });
    expect(manifest).toMatchObject({
      name: "lgtmoose-acme",
      url: "https://github.com/lgtmoose/lgtmoose",
      public: false,
      redirect_url: redirectUrl,
      hook_attributes: { url: PLACEHOLDER_WEBHOOK_URL, active: true },
    });
    expect(PLACEHOLDER_WEBHOOK_URL).toBe("https://example.invalid/webhooks/github");
  });

  it("omits the org-only members permission for a personal account", () => {
    const manifest = buildManifest({
      name: "lgtmoose-octocat",
      owner: { login: "octocat", kind: "user" },
      redirectUrl,
    });
    expect(manifest.default_permissions).not.toHaveProperty("members");
    expect(manifest.default_permissions.pull_requests).toBe("write");
  });
});

describe("newAppUrl", () => {
  it("posts to the organization's settings for an org", () => {
    expect(newAppUrl({ login: "acme", kind: "org" }, "s1")).toBe(
      "https://github.com/organizations/acme/settings/apps/new?state=s1",
    );
  });

  it("posts to the personal settings for a user", () => {
    expect(newAppUrl({ login: "octocat", kind: "user" }, "s1")).toBe(
      "https://github.com/settings/apps/new?state=s1",
    );
  });

  it("encodes the state", () => {
    expect(newAppUrl({ login: "octocat", kind: "user" }, "a+b/c")).toContain("state=a%2Bb%2Fc");
  });
});

describe("defaultAppName", () => {
  it("scopes the name to the owner, since App names are global", () => {
    expect(defaultAppName("Acme")).toBe("lgtmoose-acme");
  });

  it("stays within GitHub's length limit without a trailing hyphen", () => {
    const name = defaultAppName("a-very-long-organization-name-x-y-z-0123456789");
    expect(name.length).toBeLessThanOrEqual(MAX_APP_NAME_LENGTH);
    expect(name.endsWith("-")).toBe(false);
  });
});

it("links to the App's install page", () => {
  expect(installUrl("lgtmoose-acme")).toBe(
    "https://github.com/apps/lgtmoose-acme/installations/new",
  );
});
