import { db } from "./db";

export interface Refund {
  orderId: string;
  amountCents: number;
}

export async function refund(input: Refund): Promise<void> {
  const order = await db.orders.find(input.orderId);
  if (input.amountCents > order.paidCents) {
    throw new Error("Refund is larger than the payment");
  }
  await db.refunds.insert(input);
}
