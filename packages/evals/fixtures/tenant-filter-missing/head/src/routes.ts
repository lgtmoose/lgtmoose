import type { Express } from "express";
import { getInvoice, listInvoices } from "./invoices.js";

export function invoiceRoutes(app: Express): void {
  app.get("/invoices", async (req, res) => {
    res.json(await listInvoices(req.auth.tenantId));
  });

  app.get("/invoices/:id", async (req, res) => {
    const invoice = await getInvoice(req.auth.tenantId, req.params.id);
    if (invoice === undefined) {
      res.status(404).end();
      return;
    }
    res.json(invoice);
  });
}
