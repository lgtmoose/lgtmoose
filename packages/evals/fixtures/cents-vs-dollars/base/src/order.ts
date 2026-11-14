export interface Order {
  id: string;
  customerId: string;
  express: boolean;
  lines: { priceCents: number; quantity: number }[];
}

/** The order's subtotal in cents. */
export function subtotalCents(order: Order): number {
  return order.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
}
