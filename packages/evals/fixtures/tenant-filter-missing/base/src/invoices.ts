import { pool, type Invoice } from "./db.js";

/** Every invoice of one tenant, newest first. */
export async function listInvoices(tenantId: string): Promise<Invoice[]> {
  const { rows } = await pool.query<Invoice>(
    "SELECT id, tenant_id AS \"tenantId\", total_cents AS \"totalCents\", status FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC",
    [tenantId],
  );
  return rows;
}
