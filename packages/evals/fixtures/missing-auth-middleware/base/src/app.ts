import express from "express";
import { requireAdmin } from "./auth.js";
import { listUsers } from "./users.js";

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.send("ok");
});

app.get("/admin/users", requireAdmin, listUsers);
