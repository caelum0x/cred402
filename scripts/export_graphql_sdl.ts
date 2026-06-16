/**
 * export_graphql_sdl.ts — write the Cred402 GraphQL schema to an SDL file for
 * client codegen tooling.
 *
 *   npm run graphql:sdl   ->   packages/graphql/schema.graphql
 */
import { printSchema } from "graphql";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "../lib/graphql/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "packages", "graphql");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "schema.graphql");
const sdl = printSchema(schema);
writeFileSync(out, sdl + "\n");
console.log(`wrote ${out} (${sdl.split("\n").length} lines)`);
console.log(sdl);
