/**
 * Codex's `--output-schema` uses OpenAI's strict structured outputs: every object lists all its
 * properties as required and allows no others, so an optional field has to be nullable instead.
 * `strictSchema` converts a JSON Schema to that form, and `dropOptionalNulls` turns the nulls
 * the model sends for optional fields back into missing fields, so zod validates the answer as
 * the caller's schema expects.
 */

type JsonSchema = Record<string, unknown>;

function isSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function propertiesOf(schema: JsonSchema): Record<string, unknown> | undefined {
  return isSchema(schema.properties) ? schema.properties : undefined;
}

function requiredOf(schema: JsonSchema): Set<string> {
  return new Set(
    Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === "string") : [],
  );
}

/** The schema, or the same schema that also allows null. */
function nullable(schema: unknown): unknown {
  if (!isSchema(schema)) return schema;
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

/** Converts a JSON Schema to the strict form Codex's `--output-schema` needs. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!isSchema(schema)) return schema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" || key === "required" || key === "additionalProperties") continue;
    if (key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf") {
      out[key] = strictSchema(value);
    } else if (key === "definitions" || key === "$defs") {
      out[key] = isSchema(value)
        ? Object.fromEntries(Object.entries(value).map(([name, def]) => [name, strictSchema(def)]))
        : value;
    } else {
      out[key] = value;
    }
  }
  const properties = propertiesOf(schema);
  if (properties !== undefined) {
    const required = requiredOf(schema);
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [
        name,
        required.has(name) ? strictSchema(property) : nullable(strictSchema(property)),
      ]),
    );
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  } else if (schema.type === "object") {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Removes the nulls the model sent for fields the original schema marks optional, following
 * the schema into objects and arrays. Other values, including nulls the original schema allows
 * on required fields, are left as they are.
 */
export function dropOptionalNulls(value: unknown, schema: unknown): unknown {
  if (!isSchema(schema)) return value;
  if (Array.isArray(value)) {
    return isSchema(schema.items)
      ? value.map((item) => dropOptionalNulls(item, schema.items))
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  const properties = propertiesOf(schema);
  if (properties === undefined) return value;
  const required = requiredOf(schema);
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (item === null && !required.has(name) && name in properties) continue;
    out[name] = name in properties ? dropOptionalNulls(item, properties[name]) : item;
  }
  return out;
}
