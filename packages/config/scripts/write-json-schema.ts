import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jsonSchemas, serializeSchema } from "../src/json-schema.js";

const outDir = fileURLToPath(new URL("../schema/", import.meta.url));

for (const [name, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(`${outDir}${name}`, serializeSchema(schema));
  console.log(`wrote schema/${name}`);
}
