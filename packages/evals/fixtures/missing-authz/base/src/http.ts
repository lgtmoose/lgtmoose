export interface Order {
  id: string;
  ownerId: string;
  status: "open" | "cancelled";
}

export interface Db {
  orders: {
    find(id: string): Promise<Order | undefined>;
    update(id: string, fields: Partial<Order>): Promise<void>;
  };
}

export interface Request {
  params: { id: string };
  user?: { id: string };
}

export interface Response {
  status(code: number): Response;
  json(body: unknown): void;
  end(): void;
}
