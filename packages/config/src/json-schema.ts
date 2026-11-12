import { z } from "zod";
import { deployConfigSchema } from "./deploy.js";
import { repoConfigSchema } from "./repo.js";

const SCHEMA_BASE =
  "https://raw.githubusercontent.com/lgtmoose/lgtmoose/main/packages/config/schema";

function toJsonSchema(schema: z.ZodType, id: string, title: string): Record<string, unknown> {
  return {
    ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    $id: `${SCHEMA_BASE}/${id}`,
    title,
  };
}

/** JSON Schemas for editor autocompletion. Written to packages/config/schema by `pnpm schema`. */
export function jsonSchemas(): Record<string, Record<string, unknown>> {
  return {
    "lgtmoose.config.schema.json": toJsonSchema(
      deployConfigSchema,
      "lgtmoose.config.schema.json",
      "LGTMoose deployment config (lgtmoose.config.ts)",
    ),
    "lgtmoose.repo.schema.json": toJsonSchema(
      repoConfigSchema,
      "lgtmoose.repo.schema.json",
      "LGTMoose repository config (.lgtmoose.yaml)",
    ),
  };
}

export function serializeSchema(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
