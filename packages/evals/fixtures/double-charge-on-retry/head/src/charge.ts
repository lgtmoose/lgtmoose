import { TimeoutError, type Provider } from "./provider.js";

const ATTEMPTS = 3;

export async function chargeOrder(
  provider: Provider,
  order: { id: string; customerId: string; totalCents: number },
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { chargeId } = await provider.charge({
        customerId: order.customerId,
        amountCents: order.totalCents,
      });
      return chargeId;
    } catch (error) {
      if (!(error instanceof TimeoutError) || attempt === ATTEMPTS) throw error;
    }
  }
}
