import { fmt } from "./money.js";

/** One line of a receipt: the item and its price. */
export function receiptLine(name: string, cents: number): string {
  return `${name.padEnd(20)} ${fmt(cents)}`;
}

/** The receipt's last line. */
export function receiptTotal(cents: number): string {
  return `${"Total".padEnd(20)} ${fmt(cents)}`;
}
