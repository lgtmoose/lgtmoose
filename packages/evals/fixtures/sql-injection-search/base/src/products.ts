import { pool } from "./db.js";

export interface Product {
  id: string;
  name: string;
  priceCents: number;
}

/** One page of products, by name. */
export async function listProducts(limit: number): Promise<Product[]> {
  const { rows } = await pool.query<Product>(
    "SELECT id, name, price_cents AS \"priceCents\" FROM products ORDER BY name LIMIT $1",
    [limit],
  );
  return rows;
}
