import { logger } from "./logger.js";

const API = "https://api.payouts.example/v1/payouts";

export async function sendPayout(accountId: string, amountCents: number): Promise<void> {
  const headers = {
    authorization: `Bearer ${process.env.PAYOUTS_API_KEY}`,
    "content-type": "application/json",
  };
  const body = JSON.stringify({ accountId, amountCents });
  logger.info("sending payout", { url: API, headers, body });
  const response = await fetch(API, { method: "POST", headers, body });
  if (!response.ok) throw new Error(`Payout failed: HTTP ${response.status}`);
}
