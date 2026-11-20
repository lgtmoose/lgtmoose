import { listSavedCards, type SavedCard } from "./cards.js";
import { pay } from "./pay.js";

/** The cards this checkout can offer. */
export function offeredCards(cards: readonly SavedCard[]): SavedCard[] {
  return listSavedCards(cards);
}

/** Confirms payment with a new card or one the customer already saved. */
export async function submit(input: {
  confirmationTokenId?: string;
  savedPaymentMethodId?: string;
}): Promise<string> {
  return pay(input);
}
