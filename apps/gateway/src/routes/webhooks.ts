import express, { Router } from "express";
import { MAX_WEBHOOK_BYTES } from "../paths.js";

/**
 * GitHub webhook deliveries.
 *
 * The body is parsed as raw bytes on this route only: the signature in `X-Hub-Signature-256` is
 * an HMAC of the exact bytes GitHub sent, so any JSON parsing before verification would break it.
 * `req.body` is therefore a Buffer here, and handlers parse JSON themselves after verifying.
 */
export function webhooksRouter(maxBytes: string | number = MAX_WEBHOOK_BYTES): Router {
  const router = Router();

  router.post("/github", express.raw({ type: () => true, limit: maxBytes }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      throw new Error("webhook body was parsed before signature verification");
    }
    // NIC-804: verify the signature, dedupe by X-GitHub-Delivery, and enqueue the job.
    res.status(501).json({ error: "Webhook handling isn't built yet (NIC-804)." });
  });

  return router;
}
