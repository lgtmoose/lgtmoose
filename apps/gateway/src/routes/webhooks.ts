import express, { Router, type RequestHandler } from "express";
import { reviewJobGroupId, toReviewJob } from "@lgtmoose/core";
import { MAX_WEBHOOK_BYTES } from "../paths.js";
import type { JobQueue, WebhookSecretSource } from "../ports.js";
import { parseSignature, signatureMatches } from "../signature.js";

export interface WebhookDeps {
  secrets: WebhookSecretSource;
  queue: JobQueue;
  /** GitHub orgs or users whose repositories may be reviewed. */
  allowedOrgs: readonly string[];
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * GitHub webhook deliveries.
 *
 * The body is parsed as raw bytes on this route only: the signature in `X-Hub-Signature-256` is
 * an HMAC of the exact bytes GitHub sent, so any JSON parsing before verification would break it.
 * `req.body` is therefore a Buffer here, and the handler parses it itself after verifying.
 */
export function webhooksRouter(
  deps: WebhookDeps,
  maxBytes: string | number = MAX_WEBHOOK_BYTES,
): Router {
  const router = Router();

  router.post(
    "/github",
    express.raw({ type: () => true, limit: maxBytes }),
    githubWebhookHandler(deps),
  );

  return router;
}

/** GitHub's delivery IDs are GUIDs; anything SQS couldn't take as a deduplication ID is refused. */
const DELIVERY_ID = /^[\w.:-]{1,128}$/;

/**
 * Verify, parse, normalise, enqueue: nothing else, so GitHub's 10-second timeout is never close.
 * Responses:
 * - 400 empty body, missing headers or an unparseable payload
 * - 401 missing or bad signature, deliberately without saying which
 * - 200 `{ ok: true }` for ping, `{ ignored: reason }` for deliveries that aren't jobs
 * - 202 `{ queued: true }` once the job is on the queue
 * - 500 (via the error handler) when the secret or queue fails, so GitHub marks the delivery
 *   failed and it can be redelivered
 */
export function githubWebhookHandler(deps: WebhookDeps): RequestHandler {
  const now = deps.now ?? (() => new Date());

  return async (req, res) => {
    // No body at all (express.raw leaves req.body unset) or an empty one: a client error.
    if (req.body === undefined || (Buffer.isBuffer(req.body) && req.body.length === 0)) {
      res.status(400).json({ error: "Empty body" });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      throw new Error("webhook body was parsed before signature verification");
    }
    const body = req.body;

    // Nothing in the request is trusted, headers included, until the signature checks out.
    if (!(await verified(deps.secrets, body, req.get("x-hub-signature-256")))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const event = req.get("x-github-event");
    const deliveryId = req.get("x-github-delivery");
    if (event === undefined || event === "") {
      res.status(400).json({ error: "Missing X-GitHub-Event header" });
      return;
    }
    if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) {
      res.status(400).json({ error: "Missing or invalid X-GitHub-Delivery header" });
      return;
    }

    const parsed = parsePayload(body, req.get("content-type"));
    if (parsed === undefined) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }

    if (event === "ping") {
      res.status(200).json({ ok: true });
      return;
    }

    const result = toReviewJob(event, parsed.payload, {
      deliveryId,
      allowedOrgs: deps.allowedOrgs,
      receivedAt: now(),
    });
    if ("ignored" in result) {
      res.status(200).json({ ignored: result.ignored });
      return;
    }

    await deps.queue.send(result, { groupId: reviewJobGroupId(result), dedupeId: deliveryId });
    res.status(202).json({ queued: true });
  };
}

/**
 * Checks the signature against the cached secret, then once more against a fresh copy if that
 * differs: after a rotation the cache holds the old secret until it expires, and GitHub already
 * signs with the new one. A missing or malformed header fails without touching the secret at all.
 */
export async function verified(
  secrets: WebhookSecretSource,
  body: Buffer,
  header: string | undefined,
  matches: typeof signatureMatches = signatureMatches,
): Promise<boolean> {
  const signature = parseSignature(header);
  if (signature === undefined) return false;
  const cached = await secrets.get();
  if (matches(body, signature, cached)) return true;
  const fresh = await secrets.get({ refresh: true });
  // The refresh is throttled, so it often hands back the same secret: don't HMAC a (up to 25 MB)
  // body a second time when the answer can't change.
  return fresh !== cached && matches(body, signature, fresh);
}

/**
 * GitHub sends either `application/json` or `application/x-www-form-urlencoded` with the JSON in
 * a `payload` field, depending on the App's settings. Returns undefined when neither parses.
 */
export function parsePayload(
  body: Buffer,
  contentType: string | undefined,
): { payload: unknown } | undefined {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  let text: string | null = body.toString("utf8");
  if (mediaType === "application/x-www-form-urlencoded") {
    text = new URLSearchParams(text).get("payload");
    if (text === null) return undefined;
  }
  try {
    return { payload: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}
