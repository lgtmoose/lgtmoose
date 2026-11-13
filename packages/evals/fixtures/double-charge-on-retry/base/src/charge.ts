import type { Provider } from "./provider.js";

export async function chargeOrder(
  provider: Provider,
  order: { id: string; customerId: string; totalCents: number },
): Promise<string> {
  const { chargeId } = await provider.charge({
    customerId: order.customerId,
    amountCents: order.totalCents,
  });
  return chargeId;
}
