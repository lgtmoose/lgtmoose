import type { Db, Request, Response } from "../http.js";

/** 403 unless the signed-in user owns the order. */
function requireOwner(req: Request, ownerId: string): void {
  if (req.user?.id !== ownerId) throw Object.assign(new Error("forbidden"), { status: 403 });
}

export async function getOrder(db: Db, req: Request, res: Response): Promise<void> {
  const order = await db.orders.find(req.params.id);
  if (order === undefined) return res.status(404).end();
  requireOwner(req, order.ownerId);
  res.json(order);
}

export async function cancelOrder(db: Db, req: Request, res: Response): Promise<void> {
  const order = await db.orders.find(req.params.id);
  if (order === undefined) return res.status(404).end();
  await db.orders.update(order.id, { status: "cancelled" });
  res.status(204).end();
}
