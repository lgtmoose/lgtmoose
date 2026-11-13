import type { Express } from "express";
import type { SettingsStore } from "./store.js";

export function settingsRoutes(app: Express, store: SettingsStore): void {
  app.get("/settings/notifications", async (req, res) => {
    res.json((await store.load(req.user.id)) ?? { email: true, push: false });
  });

  app.put("/settings/notifications", async (req, res) => {
    const settings = { email: req.body.email === true, push: req.body.push === true };
    store.save(req.user.id, settings);
    res.json(settings);
  });
}
