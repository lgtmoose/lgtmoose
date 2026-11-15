import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configReferenceMarkdown } from "../src/reference.js";

const page = fileURLToPath(new URL("../../../docs/configuration.md", import.meta.url));
writeFileSync(page, configReferenceMarkdown());
console.log("wrote docs/configuration.md");
