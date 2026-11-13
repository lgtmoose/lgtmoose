import type { Request, Response } from "express";
import { db } from "./db.js";

export async function listUsers(_req: Request, res: Response): Promise<void> {
  res.json(await db.users.findMany());
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  await db.users.delete({ where: { id: req.params.id } });
  res.status(204).end();
}
