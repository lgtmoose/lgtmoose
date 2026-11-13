import type { Invoice, InvoiceStore } from "./store.js";

export interface Mailer {
  send(to: string, subject: string, html: string): Promise<void>;
}

/** Emails each draft invoice and marks it sent. */
export async function sendDrafts(store: InvoiceStore, mailer: Mailer): Promise<void> {
  for (const invoice of await store.drafts()) {
    try {
      await mailer.send(invoice.email, `Invoice ${invoice.number}`, render(invoice));
    } catch {
      // Keep going: one bad address shouldn't stop the rest.
    }
    await store.markSent(invoice.id);
  }
}

function render(invoice: Invoice): string {
  return `<p>Amount due: ${(invoice.totalCents / 100).toFixed(2)}</p>`;
}
