/** Refresh the checked-in catalog: node scripts/generate-error-catalog.mjs /path/to/shared/service/error_catalog.json */
import { readFileSync, writeFileSync } from "node:fs";
if (!process.argv[2]) throw new Error("Pass the shared service/error_catalog.json path.");
const catalog = readFileSync(process.argv[2], "utf8");
JSON.parse(catalog);
writeFileSync(new URL("../test/fixtures/error-catalog.json", import.meta.url), catalog);
writeFileSync(new URL("../src/error-catalog.ts", import.meta.url),
  "// Generated from the shared service/error_catalog.json; verify against test/fixtures/error-catalog.json.\nexport const errorCatalog = " + catalog.trimEnd() + " as const;\n");
