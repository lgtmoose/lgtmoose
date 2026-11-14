/** The payment provider's client. Every amount is in cents, as an integer. */
export interface Payments {
  charge(request: { customerId: string; amountCents: number; currency: "usd" }): Promise<{ id: string }>;
}
