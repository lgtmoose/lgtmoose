import type { Express } from "express";
import type { SettingsStore } from "./store.js";

export function settingsRoutes(app: Express, store: SettingsStore): void {
  app.get("/settings/notifications", async (req, res) => {
    res.json((await store.load(req.user.id)) ?? { email: true, push: false });
  });
}
