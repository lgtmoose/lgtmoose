import { readFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { EXPORT_DIR } from "./config.js";

export const app = express();

app.get("/health", (_req, res) => {
  res.send("ok");
});

app.get("/exports", async (req, res) => {
  const file = String(req.query.file ?? "");
  try {
    const data = await readFile(join(EXPORT_DIR, file));
    res.type("text/csv").send(data);
  } catch {
    res.status(404).end();
  }
});
