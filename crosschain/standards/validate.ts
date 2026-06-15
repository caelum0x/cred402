import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * A small, dependency-free JSON-Schema validator covering the subset used by the
 * Cred402 envelope schemas (type, required, additionalProperties, const, pattern,
 * minimum/maximum, minLength). Real validation — used to gate envelopes at trust
 * boundaries before they are anchored to Casper.
 */
type Schema = {
  type?: string;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  const?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  description?: string;
};

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const cache = new Map<string, Schema>();

export const SCHEMA_FILES = {
  address_binding: "address-binding-envelope.schema.json",
  universal_receipt: "universal-receipt-envelope.schema.json",
  credit_authorization_note: "credit-authorization-note.schema.json",
  evidence_attestation: "evidence-attestation-envelope.schema.json",
} as const;

export type SchemaName = keyof typeof SCHEMA_FILES;

function loadSchema(name: SchemaName): Schema {
  const cached = cache.get(name);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(resolve(SCHEMA_DIR, SCHEMA_FILES[name]), "utf8")) as Schema;
  cache.set(name, schema);
  return schema;
}

export function validateAgainstSchema(name: SchemaName, value: unknown): ValidationResult {
  return validateNode(loadSchema(name), value, "$");
}

function validateNode(schema: Schema, value: unknown, path: string): ValidationResult {
  const errors: string[] = [];

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.type) {
    const actual = jsonType(value);
    if (actual !== schema.type) errors.push(`${path}: expected ${schema.type}, got ${actual}`);
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match /${schema.pattern}/`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validateNode(child, obj[key], `${path}.${key}`).errors);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) if (!allowed.has(key)) errors.push(`${path}.${key}: additional property not allowed`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}
