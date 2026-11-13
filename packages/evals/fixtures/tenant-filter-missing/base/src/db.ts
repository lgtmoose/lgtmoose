import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export interface Invoice {
  id: string;
  tenantId: string;
  totalCents: number;
  status: "draft" | "sent" | "paid";
}
