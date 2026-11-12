import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";

/** Lambda entry point behind the API Gateway HTTP API (payload format 2.0). */
export const handler = handle(createApp({ version: process.env.LGTMOOSE_VERSION ?? "unknown" }));
