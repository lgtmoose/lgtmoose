export interface Invoice {
  id: string;
  number: string;
  email: string;
  totalCents: number;
}

export interface InvoiceStore {
  drafts(): Promise<Invoice[]>;
  markSent(id: string): Promise<void>;
}
