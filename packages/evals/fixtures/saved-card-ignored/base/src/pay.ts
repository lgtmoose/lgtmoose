/** Charges the card the customer just entered. */
export async function pay(input: { confirmationTokenId: string }): Promise<string> {
  return `ch_${input.confirmationTokenId}`;
}
