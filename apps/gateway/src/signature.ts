import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * The digest from an `X-Hub-Signature-256: sha256=<hex>` header, or undefined when the header is
 * missing or malformed. Checking the shape first means junk never costs a secret lookup.
 */
export function parseSignature(header: string | undefined): Buffer | undefined {
  if (header === undefined || !header.startsWith(PREFIX)) return undefined;
  const hex = header.slice(PREFIX.length);
  return HEX_SHA256.test(hex) ? Buffer.from(hex, "hex") : undefined;
}

/** Whether `signature` is the HMAC-SHA256 of the exact body bytes under `secret`. */
export function signatureMatches(body: Buffer, signature: Buffer, secret: string): boolean {
  // Anyone can compute an HMAC with an empty key, so an empty secret must never verify.
  if (secret.length === 0) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  // timingSafeEqual throws on unequal lengths; parseSignature already fixes the length at 32
  // bytes, but check anyway so a future caller can't turn a bad header into a 500.
  return signature.length === expected.length && timingSafeEqual(signature, expected);
}

/** `sha256=<hex>` for a body, as GitHub would send it. Used by tests and local tooling. */
export function signBody(body: Buffer | string, secret: string): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}
