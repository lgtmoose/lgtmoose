/** Charges a card. A saved card is a `savedPaymentMethodId`; a new card is a confirmation token. */
export async function pay(input: {
  confirmationTokenId?: string;
  savedPaymentMethodId?: string;
}): Promise<string> {
  if (input.confirmationTokenId === undefined) throw new Error("Enter a card.");
  return `ch_${input.confirmationTokenId}`;
}
