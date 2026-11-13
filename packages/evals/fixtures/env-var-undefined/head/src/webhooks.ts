import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config.js";

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const expected = createHmac("sha256", config.webhookSecret).update(req.rawBody).digest();
  const given = Buffer.from(String(req.headers["x-signature"] ?? ""), "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.status(401).end();
    return;
  }
  res.status(204).end();
}
