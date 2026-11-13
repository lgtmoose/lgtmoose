import type { NextFunction, Request, Response } from "express";

/** Lets the request through only for a signed-in admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.user?.role !== "admin") {
    res.status(403).json({ error: "admins only" });
    return;
  }
  next();
}
