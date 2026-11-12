import { createApp } from "./app.js";

/** Runs the gateway as a plain Node server, for local development and docker compose. */
const port = Number(process.env.PORT ?? 3000);
const app = createApp({ version: process.env.LGTMOOSE_VERSION ?? "dev" });

app.listen(port, () => {
  console.log(`LGTMoose gateway listening on http://localhost:${port}`);
});
