/** Generate the language-neutral contract consumed by the Python backend. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as shared from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "contract");
mkdirSync(outDir, { recursive: true });

const definitions: Record<string, z.ZodTypeAny> = {};
for (const [name, value] of Object.entries(shared)) {
  if (value instanceof z.ZodType && name.endsWith("Schema")) {
    definitions[name.slice(0, -"Schema".length)] = value;
  }
}

const names = Object.keys(definitions).sort();
if (names.length === 0) throw new Error("contract-export: no *Schema exports found");

const rendered = zodToJsonSchema(z.object({}), {
  definitions,
  definitionPath: "$defs",
  target: "jsonSchema2019-09",
  $refStrategy: "root",
}) as Record<string, unknown>;
const defs = (rendered.$defs ?? {}) as Record<string, Record<string, unknown>>;

if (Object.keys(defs).length !== names.length) {
  throw new Error(`contract-export: expected ${names.length} definitions, emitted ${Object.keys(defs).length}`);
}

// Zod objects strip unknown keys. zod-to-json-schema emits false here, which
// would make Pydantic reject them instead; remove it to preserve behavior.
function preserveZodObjectSemantics(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(preserveZodObjectSemantics);
    return;
  }
  if (!node || typeof node !== "object") return;
  const object = node as Record<string, unknown>;
  if (object.additionalProperties === false) object.additionalProperties = undefined;
  Object.values(object).forEach(preserveZodObjectSemantics);
}
preserveZodObjectSemantics(defs);

for (const [name, schema] of Object.entries(defs)) schema.title ??= name;

writeFileSync(
  join(outDir, "contract.schema.json"),
  `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $comment: "GENERATED from shared Zod schemas. Do not edit.",
    $defs: defs,
  }, null, 2)}\n`,
);

console.log(`contract-export: ${names.length} schemas -> contract/contract.schema.json`);
