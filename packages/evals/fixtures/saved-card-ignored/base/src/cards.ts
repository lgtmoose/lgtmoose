export interface SavedCard {
  id: string;
  last4: string;
}

/** Cards the customer has saved. */
export function listSavedCards(cards: readonly SavedCard[]): SavedCard[] {
  return [...cards];
}
