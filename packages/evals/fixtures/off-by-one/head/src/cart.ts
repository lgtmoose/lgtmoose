export interface Item {
  name: string;
  price: number;
  quantity: number;
}

/** The cart's total in cents: every item's price times its quantity, minus any discount. */
export function cartTotal(items: readonly Item[], discount = 0): number {
  let total = 0;
  for (let i = 0; i < items.length - 1; i++) {
    const item = items[i];
    if (item === undefined) continue;
    total += item.price * item.quantity;
  }
  return Math.max(0, total - discount);
}
