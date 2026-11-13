import type { Express } from "express";
import bcrypt from "bcrypt";
import type { Collection } from "mongodb";
import { asString } from "./validate.js";

interface User {
  email: string;
  passwordHash: string;
  resetToken?: string;
}

export function accountRoutes(app: Express, users: Collection<User>): void {
  app.post("/login", async (req, res) => {
    const email = asString(req.body.email, "email");
    const user = await users.findOne({ email });
    if (user === null || !(await bcrypt.compare(asString(req.body.password, "password"), user.passwordHash))) {
      res.status(401).end();
      return;
    }
    res.json({ ok: true });
  });

  app.post("/reset", async (req, res) => {
    const user = await users.findOne({ resetToken: req.body.token });
    if (user === null) {
      res.status(400).json({ error: "invalid token" });
      return;
    }
    const passwordHash = await bcrypt.hash(asString(req.body.password, "password"), 12);
    await users.updateOne({ email: user.email }, { $set: { passwordHash }, $unset: { resetToken: "" } });
    res.json({ ok: true });
  });
}
