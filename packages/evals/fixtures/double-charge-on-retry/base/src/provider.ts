export class TimeoutError extends Error {}

export interface ChargeRequest {
  customerId: string;
  amountCents: number;
  /**
   * The provider charges a request with the same key at most once, and returns the first
   * charge for repeats. Without one, every request is a new charge.
   */
  idempotencyKey?: string;
}

export interface Provider {
  /** Throws TimeoutError when no answer came in time; the charge may still have gone through. */
  charge(request: ChargeRequest): Promise<{ chargeId: string }>;
}
