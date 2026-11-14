import type { Express } from "express";
import { listInvoices } from "./invoices.js";

export function invoiceRoutes(app: Express): void {
  app.get("/invoices", async (req, res) => {
    res.json(await listInvoices(req.auth.tenantId));
  });
}
