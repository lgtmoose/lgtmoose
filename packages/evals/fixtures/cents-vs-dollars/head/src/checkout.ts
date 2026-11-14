import { subtotalCents, type Order } from "./order.js";
import type { Payments } from "./payments.js";

/** Shipping for an order: 4.99 standard, 12.50 express. */
export function shippingFee(order: Order): number {
  return order.express ? 12.5 : 4.99;
}

export async function checkout(order: Order, payments: Payments): Promise<string> {
  const amountCents = subtotalCents(order) + shippingFee(order);
  const { id } = await payments.charge({ customerId: order.customerId, amountCents, currency: "usd" });
  return id;
}
