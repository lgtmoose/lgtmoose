import express from "express";
import { handleWebhook } from "./webhooks.js";

export const app = express();

// Keep the exact bytes of each body: webhook signatures are computed over them.
app.use(
  express.json({
    verify: (req, _res, buffer) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buffer;
    },
  }),
);

app.post("/webhooks/payments", handleWebhook);
