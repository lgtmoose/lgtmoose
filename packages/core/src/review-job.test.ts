import { describe, expect, it } from "vitest";
import {
  REVIEW_JOB_KINDS,
  SKIP_LABEL,
  isReviewJobKind,
  reviewJobGroupId,
  toReviewJob,
  type ReviewJob,
} from "./review-job.js";

const options = {
  deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  allowedOrgs: ["Acme-Corp"],
  receivedAt: new Date("2026-11-12T10:00:00.000Z"),
};

const repository = { full_name: "acme-corp/widgets", owner: { login: "acme-corp" } };
const installation = { id: 4242 };
const human = { login: "octo-dev", type: "User" };

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 17,
    draft: false,
    labels: [{ name: "enhancement" }],
    head: { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
    ...overrides,
  };
}

function prEvent(action: string, pr: Record<string, unknown> = {}, extra = {}) {
  return {
    action,
    pull_request: pullRequest(pr),
    repository,
    installation,
    sender: human,
    ...extra,
  };
}

const base = {
  deliveryId: options.deliveryId,
  installationId: 4242,
  repo: "acme-corp/widgets",
  prNumber: 17,
  actor: "octo-dev",
  receivedAt: "2026-11-12T10:00:00.000Z",
};
const head = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("toReviewJob: pull_request", () => {
  it.each([
    ["opened", "pr_opened"],
    ["reopened", "pr_opened"],
    ["synchronize", "pr_updated"],
    ["ready_for_review", "pr_ready"],
    ["closed", "pr_closed"],
  ])("maps %s to %s", (action, kind) => {
    expect(toReviewJob("pull_request", prEvent(action), options)).toEqual({
      ...base,
      kind,
      headSha: head,
    });
  });

  it.each(["edited", "labeled", "assigned", "converted_to_draft", "review_requested"])(
    "ignores %s",
    (action) => {
      expect(toReviewJob("pull_request", prEvent(action), options)).toEqual({
        ignored: `unsupported action: pull_request.${action}`,
      });
    },
  );

  it("carries the PR's updated_at as the event time, and drops one that isn't a time", () => {
    const at = toReviewJob(
      "pull_request",
      prEvent("synchronize", { updated_at: "2026-11-12T09:59:58Z" }),
      options,
    );
    expect(at).toMatchObject({ eventAt: "2026-11-12T09:59:58.000Z" });
    const bad = toReviewJob(
      "pull_request",
      prEvent("synchronize", { updated_at: "soon" }),
      options,
    );
    expect(bad).not.toHaveProperty("eventAt");
  });

  it("keeps only what the dispatcher needs", () => {
    const payload = prEvent("opened", { title: "Add widgets", body: "x".repeat(10_000) });
    const job = toReviewJob("pull_request", payload, options) as ReviewJob;
    expect(Object.keys(job).sort()).toEqual(
      [
        "actor",
        "deliveryId",
        "headSha",
        "installationId",
        "kind",
        "prNumber",
        "receivedAt",
        "repo",
      ].sort(),
    );
  });
});

describe("toReviewJob: comments, reviews and threads", () => {
  const issue = { number: 17, labels: [], pull_request: { url: "https://api.github.com/x" } };

  it("maps a comment on a PR, without a head SHA (issue_comment doesn't carry one)", () => {
    const payload = { action: "created", issue, comment: { id: 901 }, repository, installation };
    expect(toReviewJob("issue_comment", { ...payload, sender: human }, options)).toEqual({
      ...base,
      kind: "comment",
      commentId: 901,
    });
  });

  it("ignores a comment on a plain issue", () => {
    const payload = {
      action: "created",
      issue: { number: 3, labels: [] },
      comment: { id: 1 },
      repository,
      installation,
      sender: human,
    };
    expect(toReviewJob("issue_comment", payload, options)).toEqual({
      ignored: "not a pull request",
    });
  });

  it("ignores edited and deleted comments", () => {
    for (const action of ["edited", "deleted"]) {
      const payload = {
        action,
        issue,
        comment: { id: 1 },
        repository,
        installation,
        sender: human,
      };
      expect(toReviewJob("issue_comment", payload, options)).toEqual({
        ignored: `unsupported action: issue_comment.${action}`,
      });
    }
  });

  it("applies the skip label and draft rules to comments via the issue", () => {
    const labelled = { ...issue, labels: [{ name: SKIP_LABEL }] };
    const payload = { action: "created", issue: labelled, repository, installation, sender: human };
    expect(toReviewJob("issue_comment", payload, options)).toEqual({
      ignored: `labelled ${SKIP_LABEL}`,
    });
    const draft = { ...payload, issue: { ...issue, draft: true } };
    expect(toReviewJob("issue_comment", draft, options)).toEqual({ ignored: "draft pull request" });
  });

  it("maps a submitted review", () => {
    const payload = prEvent("submitted", {}, { review: { id: 77, state: "commented" } });
    expect(toReviewJob("pull_request_review", payload, options)).toEqual({
      ...base,
      kind: "review",
      headSha: head,
      reviewId: 77,
    });
    expect(toReviewJob("pull_request_review", prEvent("dismissed"), options)).toEqual({
      ignored: "unsupported action: pull_request_review.dismissed",
    });
  });

  it("maps a new review comment", () => {
    const payload = prEvent("created", {}, { comment: { id: 555, path: "src/a.ts" } });
    expect(toReviewJob("pull_request_review_comment", payload, options)).toEqual({
      ...base,
      kind: "review_comment",
      headSha: head,
      commentId: 555,
    });
  });

  it.each([
    ["resolved", "thread_resolved"],
    ["unresolved", "thread_unresolved"],
  ])("maps a %s review thread", (action, kind) => {
    const payload = prEvent(action, {}, { thread: { node_id: "PRRT_kwDOA", comments: [] } });
    expect(toReviewJob("pull_request_review_thread", payload, options)).toEqual({
      ...base,
      kind,
      headSha: head,
      threadNodeId: "PRRT_kwDOA",
    });
  });

  it("carries a review thread's first comment ID", () => {
    const payload = prEvent(
      "resolved",
      {},
      {
        thread: { node_id: "PRRT_kwDOA", comments: [{ id: 3_000_000_001 }, { id: 3_000_000_002 }] },
      },
    );
    expect(toReviewJob("pull_request_review_thread", payload, options)).toMatchObject({
      kind: "thread_resolved",
      threadNodeId: "PRRT_kwDOA",
      commentId: 3_000_000_001,
    });
  });
});

describe("toReviewJob: ignore rules", () => {
  it("ignores events it doesn't handle", () => {
    expect(toReviewJob("push", { ref: "refs/heads/main" }, options)).toEqual({
      ignored: "unsupported event: push",
    });
    expect(
      toReviewJob("pull_request", { ...prEvent("opened"), action: undefined }, options),
    ).toEqual({ ignored: "unsupported action: pull_request.none" });
  });

  it("never resolves event or action names to inherited object properties", () => {
    for (const event of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(toReviewJob(event, prEvent("opened"), options)).toEqual({
        ignored: `unsupported event: ${event}`,
      });
    }
    for (const action of ["constructor", "__proto__", "toString", "valueOf"]) {
      expect(toReviewJob("pull_request", { ...prEvent("opened"), action }, options)).toEqual({
        ignored: `unsupported action: pull_request.${action}`,
      });
    }
  });

  it("ignores payloads that aren't objects", () => {
    for (const payload of [null, [], "x", 3]) {
      expect(toReviewJob("pull_request", payload, options)).toEqual({
        ignored: "payload is not an object",
      });
    }
  });

  it("ignores payloads missing the fields a job needs", () => {
    for (const payload of [
      { ...prEvent("opened"), installation: undefined },
      { ...prEvent("opened"), repository: { full_name: "acme-corp/widgets" } },
      prEvent("opened", { number: "17" }),
      { ...prEvent("opened"), sender: undefined },
    ]) {
      expect(toReviewJob("pull_request", payload, options)).toEqual({
        ignored: "payload is missing the repository, installation, PR or sender",
      });
    }
  });

  it("ignores owners not in allowedOrgs, comparing case-insensitively", () => {
    const other = { full_name: "evil/widgets", owner: { login: "evil" } };
    expect(
      toReviewJob("pull_request", { ...prEvent("opened"), repository: other }, options),
    ).toEqual({ ignored: "owner not allowed: evil" });
    const shouting = { full_name: "ACME-CORP/widgets", owner: { login: "ACME-CORP" } };
    const job = toReviewJob(
      "pull_request",
      { ...prEvent("opened"), repository: shouting },
      options,
    );
    expect(job).toMatchObject({ kind: "pr_opened", repo: "ACME-CORP/widgets" });
  });

  it("ignores everything when allowedOrgs is empty", () => {
    const none = { ...options, allowedOrgs: [] };
    expect(toReviewJob("pull_request", prEvent("opened"), none)).toEqual({
      ignored: "owner not allowed: acme-corp",
    });
  });

  it("ignores bot senders, by type or by login", () => {
    for (const sender of [
      { login: "lgtmoose[bot]", type: "Bot" },
      { login: "renovate[bot]", type: "User" },
      { login: "some-app", type: "Bot" },
    ]) {
      expect(toReviewJob("pull_request", { ...prEvent("opened"), sender }, options)).toEqual({
        ignored: `bot sender: ${sender.login}`,
      });
    }
  });

  it("ignores drafts, but not a draft that just became ready", () => {
    expect(toReviewJob("pull_request", prEvent("opened", { draft: true }), options)).toEqual({
      ignored: "draft pull request",
    });
    expect(toReviewJob("pull_request", prEvent("synchronize", { draft: true }), options)).toEqual({
      ignored: "draft pull request",
    });
    expect(
      toReviewJob("pull_request", prEvent("ready_for_review", { draft: false }), options),
    ).toMatchObject({ kind: "pr_ready" });
  });

  it("ignores PRs labelled skip-lgtmoose", () => {
    const labels = [{ name: "bug" }, { name: SKIP_LABEL }];
    expect(toReviewJob("pull_request", prEvent("opened", { labels }), options)).toEqual({
      ignored: `labelled ${SKIP_LABEL}`,
    });
  });

  it("still cleans up when a draft, labelled or bot-closed PR closes", () => {
    const payload = prEvent(
      "closed",
      { draft: true, labels: [{ name: SKIP_LABEL }] },
      { sender: { login: "merge-bot[bot]", type: "Bot" } },
    );
    expect(toReviewJob("pull_request", payload, options)).toMatchObject({
      kind: "pr_closed",
      actor: "merge-bot[bot]",
    });
  });

  it("checks the owner before anything else about the PR, even on close", () => {
    const other = { full_name: "evil/widgets", owner: { login: "evil" } };
    expect(
      toReviewJob("pull_request", { ...prEvent("closed"), repository: other }, options),
    ).toEqual({ ignored: "owner not allowed: evil" });
  });
});

describe("helpers", () => {
  it("groups jobs by PR", () => {
    expect(reviewJobGroupId({ repo: "acme-corp/widgets", prNumber: 17 })).toBe(
      "acme-corp/widgets#17",
    );
  });

  it("recognises job kinds", () => {
    for (const kind of REVIEW_JOB_KINDS) expect(isReviewJobKind(kind)).toBe(true);
    expect(isReviewJobKind("pr_merged")).toBe(false);
    expect(isReviewJobKind(undefined)).toBe(false);
  });
});
