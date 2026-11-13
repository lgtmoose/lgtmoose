import { subtotalCents, type Order } from "./order.js";
import type { Payments } from "./payments.js";

export async function checkout(order: Order, payments: Payments): Promise<string> {
  const amountCents = subtotalCents(order);
  const { id } = await payments.charge({ customerId: order.customerId, amountCents, currency: "usd" });
  return id;
}
