import { randomUUID } from "node:crypto";
import { signBody } from "./signature.js";

/**
 * The webhook part of the AWS smoke test (`.github/workflows/smoke-aws.yml`, docs/smoke-test.md).
 * It sends signed deliveries to a deployed gateway and checks each answer:
 *
 * 1. A `ping` signed with the webhook secret: 200 `{ ok: true }`.
 * 2. The same `ping` with a wrong signature: 401. A gateway that accepts it isn't verifying.
 * 3. An `issue_comment` on a PR in an allowed org: 202 `{ queued: true }`. The gateway answers
 *    202 only once the job is on the queue. The dispatcher forwards a comment to the conversation
 *    queue and logs that, without starting a review, so the smoke test costs no model call and
 *    starts no task. The comment has no id, so the conversation Lambda ignores it before calling
 *    GitHub. The workflow then finds the delivery ID in the dispatcher's log.
 *
 * The repository and PR are made up: nothing is read from or written to GitHub.
 */

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeResult {
  checks: SmokeCheck[];
  /** The comment delivery's ID, to find in the dispatcher's log. */
  deliveryId: string;
}

/** A made-up `issue_comment.created` on PR #1 of `<owner>/lgtmoose-smoke-test`. */
export function commentPayload(owner: string, now: Date): Record<string, unknown> {
  const at = now.toISOString();
  return {
    action: "created",
    issue: { number: 1, pull_request: { url: "" }, updated_at: at, labels: [] },
    // No id: the conversation Lambda ignores the job before it asks GitHub about the comment.
    comment: { body: "lgtmoose smoke test", created_at: at },
    repository: { full_name: `${owner}/lgtmoose-smoke-test`, owner: { login: owner } },
    installation: { id: 1 },
    sender: { login: "lgtmoose-smoke-test", type: "User" },
  };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function deliver(
  fetchFn: Fetch,
  url: string,
  event: string,
  deliveryId: string,
  body: string,
  signature: string,
): Promise<{ status: number; json: unknown }> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
      "user-agent": "lgtmoose-smoke-test",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

const field = (json: unknown, key: string): unknown =>
  typeof json === "object" && json !== null ? (json as Record<string, unknown>)[key] : undefined;

/** Runs the three deliveries. Never throws for a wrong answer: each is a failed check. */
export async function runWebhookSmoke(options: {
  webhookUrl: string;
  secret: string;
  /** One of the deployment's `allowedOrgs`. */
  owner: string;
  fetch?: Fetch;
  now?: () => Date;
  newId?: () => string;
}): Promise<SmokeResult> {
  const fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const newId = options.newId ?? (() => `smoke-${randomUUID()}`);
  const checks: SmokeCheck[] = [];
  const describe = (answer: { status: number; json: unknown }) =>
    `HTTP ${answer.status} ${JSON.stringify(answer.json ?? null)}`;

  const ping = JSON.stringify({ zen: "lgtmoose smoke test", hook_id: 1 });
  const signed = await deliver(
    fetchFn,
    options.webhookUrl,
    "ping",
    newId(),
    ping,
    signBody(ping, options.secret),
  );
  checks.push({
    name: "signed ping is accepted",
    ok: signed.status === 200 && field(signed.json, "ok") === true,
    detail: describe(signed),
  });

  // A valid-looking signature under another key.
  const forged = await deliver(
    fetchFn,
    options.webhookUrl,
    "ping",
    newId(),
    ping,
    signBody(ping, `${options.secret}-wrong`),
  );
  checks.push({
    name: "wrongly signed ping is refused",
    ok: forged.status === 401,
    detail: describe(forged),
  });

  const deliveryId = newId();
  const comment = JSON.stringify(commentPayload(options.owner, options.now?.() ?? new Date()));
  const queued = await deliver(
    fetchFn,
    options.webhookUrl,
    "issue_comment",
    deliveryId,
    comment,
    signBody(comment, options.secret),
  );
  checks.push({
    name: "signed PR comment is queued",
    ok: queued.status === 202 && field(queued.json, "queued") === true,
    detail: describe(queued),
  });

  return { checks, deliveryId };
}

/** The checks as lines for the job log, and whether every one passed. */
export function report(result: SmokeResult): { lines: string[]; ok: boolean } {
  return {
    lines: result.checks.map(
      (check) => `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
    ),
    ok: result.checks.every((check) => check.ok),
  };
}
