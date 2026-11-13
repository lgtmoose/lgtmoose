export interface Item {
  name: string;
  price: number;
  quantity: number;
}

/** The cart's total in cents: every item's price times its quantity. */
export function cartTotal(items: readonly Item[]): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    total += item.price * item.quantity;
  }
  return total;
}
