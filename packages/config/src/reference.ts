import { jsonSchemas } from "./json-schema.js";

/**
 * The configuration reference page (docs/configuration.md), generated from the JSON Schemas,
 * which are generated from the zod schemas. Written by `pnpm --filter @lgtmoose/config docs`;
 * a test fails when the committed page is out of date.
 */

type Schema = Record<string, unknown>;

interface Row {
  key: string;
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
}

function asSchema(value: unknown): Schema | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function properties(schema: Schema): [string, Schema][] {
  const props = asSchema(schema.properties) ?? {};
  return Object.entries(props).flatMap(([key, value]) => {
    const child = asSchema(value);
    return child === undefined ? [] : [[key, child] as [string, Schema]];
  });
}

function requiredKeys(schema: Schema): Set<string> {
  return new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
}

/**
 * Code in a table cell. A `|` can't be escaped inside a code span the same way on GitHub and in
 * Jekyll's kramdown, so code that has one is an HTML `<code>` element with `&#124;` instead.
 */
function code(text: string): string {
  if (!text.includes("|")) return `\`${text}\``;
  const html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;");
  return `<code>${html}</code>`;
}

/** A one-line type: `string`, `integer, 1 to 64`, `"lean" or "standard"`, `list of string`. */
function typeOf(schema: Schema): string {
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => `\`${JSON.stringify(value)}\``).join(" or ");
  }
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
  if (Array.isArray(schema.oneOf)) return "one of the forms below";
  const type = schema.type;
  if (type === "array") {
    const items = asSchema(schema.items);
    const inner = items === undefined ? "any" : typeOf(items);
    const min = typeof schema.minItems === "number" ? `, at least ${schema.minItems}` : "";
    return `list of ${inner}${min}`;
  }
  if (type === "object") {
    const keys = asSchema(schema.propertyNames);
    const values = asSchema(schema.additionalProperties);
    if (keys !== undefined || (values !== undefined && properties(schema).length === 0)) {
      const keyType = keys === undefined ? "string" : typeOf(keys);
      const valueType = values === undefined ? "any" : typeOf(values);
      return `map of ${keyType} to ${valueType}`;
    }
    return "object";
  }
  if (type === "integer" || type === "number") {
    const min = schema.minimum;
    const max = schema.maximum;
    if (typeof min === "number" && typeof max === "number") return `${type}, ${min} to ${max}`;
    if (typeof min === "number") return `${type}, at least ${min}`;
    return String(type);
  }
  if (type === "string" && typeof schema.pattern === "string") {
    return `string matching ${code(schema.pattern)}`;
  }
  return typeof type === "string" ? type : "any";
}

/** Every key under `schema`, depth first, with nested objects' keys as `parent.child`. */
function rows(schema: Schema, prefix: string, required: boolean): Row[] {
  const out: Row[] = [];
  const req = requiredKeys(schema);
  for (const [key, child] of properties(schema)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    out.push({
      key: path,
      type: typeOf(child),
      required: required && req.has(key),
      ...(child.default === undefined ? {} : { default: child.default }),
      ...(typeof child.description === "string" ? { description: child.description } : {}),
    });
    const items = child.type === "array" ? asSchema(child.items) : undefined;
    if (items !== undefined && properties(items).length > 0) {
      out.push(...rows(items, `${path}[]`, true));
    } else if (properties(child).length > 0) {
      out.push(...rows(child, path, required && req.has(key)));
    } else if (Array.isArray(child.oneOf)) {
      out.push(...variantRows(child.oneOf, path));
    }
  }
  return out;
}

/**
 * A tagged union's keys: one row for the tag with every value it takes, then each form's other
 * keys, said to apply with that tag's value.
 */
function variantRows(oneOf: readonly unknown[], path: string): Row[] {
  const variants = oneOf.flatMap((value) => {
    const variant = asSchema(value);
    return variant === undefined ? [] : [variant];
  });
  const tagOf = (variant: Schema) =>
    properties(variant).find(([, field]) => field.const !== undefined);
  const tag = variants.map(tagOf).find((entry) => entry !== undefined);
  if (tag === undefined) return variants.flatMap((variant) => rows(variant, path, false));
  const [tagKey] = tag;
  const out: Row[] = [
    {
      key: `${path}.${tagKey}`,
      type: variants
        .flatMap((variant) => {
          const field = asSchema(asSchema(variant.properties)?.[tagKey]);
          return field?.const === undefined ? [] : [`\`${JSON.stringify(field.const)}\``];
        })
        .join(" or "),
      required: true,
      description: "Which form this is.",
    },
  ];
  for (const variant of variants) {
    const value = asSchema(asSchema(variant.properties)?.[tagKey])?.const;
    for (const row of rows(variant, path, false)) {
      if (row.key === `${path}.${tagKey}`) continue;
      const when = `With \`${tagKey}: ${JSON.stringify(value)}\`.`;
      out.push({ ...row, description: [when, row.description].filter(Boolean).join(" ") });
    }
  }
  return out;
}

/**
 * Escapes text for a Markdown table cell: outside code, the angle brackets that would read as
 * HTML (apart from `code()`'s own `<code>` tags) and pipes, which would end the cell.
 */
function cell(text: string): string {
  return text
    .replace(/\n/g, " ")
    .split("`")
    .map((part, index) =>
      index % 2 === 0
        ? part
            .replace(/<(?!\/?code>)/g, "&lt;")
            .replace(/(?<!<\/?code)>/g, "&gt;")
            .replace(/\|/g, "\\|")
        : part,
    )
    .join("`");
}

function table(list: readonly Row[]): string {
  const lines = ["| Key | Type | Default | Description |", "| --- | --- | --- | --- |"];
  for (const row of list) {
    const key = `\`${row.key}\`${row.required ? " (required)" : ""}`;
    const fallback = row.default === undefined ? "" : `\`${JSON.stringify(row.default)}\``;
    lines.push(
      `| ${cell(key)} | ${cell(row.type)} | ${cell(fallback)} | ${cell(row.description ?? "")} |`,
    );
  }
  return lines.join("\n");
}

/** The whole page. Deterministic: the same schemas give the same text. */
export function configReferenceMarkdown(): string {
  const schemas = jsonSchemas();
  const deploy = schemas["lgtmoose.config.schema.json"];
  const repo = schemas["lgtmoose.repo.schema.json"];
  if (deploy === undefined || repo === undefined) throw new Error("a config schema is missing");
  return `${[
    "<!-- Generated from packages/config by `pnpm --filter @lgtmoose/config docs`. Don't edit by hand. -->",
    "",
    "# Configuration reference",
    "",
    "LGTMoose has two config files. Both are checked with zod when they're read, and a bad key fails with its path. The JSON Schemas in `packages/config/schema/` give editors autocompletion.",
    "",
    "## `lgtmoose.config.ts`: the deployment",
    "",
    "One per install, in your checkout. `lgtmoose setup` writes it; `lgtmoose deploy` reads it. Export the config through `defineConfig` from `@lgtmoose/config`.",
    "",
    table(rows(deploy, "", true)),
    "",
    "Each harness accepts only some `auth` methods: `claude-code` takes `oauth-token`, `api-key`, `bedrock` and `vertex`; `codex` takes `chatgpt-login`, `access-token` and `api-key`; `cursor-agent` takes `api-key` and `service-account`; `agent-sdk` takes `api-key`, `bedrock` and `vertex`. See [Providers and auth](credentials.md).",
    "",
    "## `.lgtmoose.yaml`: per repository",
    "",
    "Optional, at the repository's root. It's read from the PR's base branch, never from the PR itself, so a PR can't change how it's reviewed. A missing or empty file gives the defaults.",
    "",
    table(rows(repo, "", true)),
  ].join("\n")}\n`;
}
