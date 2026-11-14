import type { Request, Response } from "express";

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  // TODO: verify the signature.
  res.status(204).end();
}
