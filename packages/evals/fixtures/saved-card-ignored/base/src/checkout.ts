import { pay } from "./pay.js";

/** Confirms payment with the card the customer just entered. */
export async function submit(confirmationTokenId: string): Promise<string> {
  return pay({ confirmationTokenId });
}
