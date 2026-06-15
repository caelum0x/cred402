import { ValidationError } from "./errors.js";

/**
 * Minimal, dependency-free schema validation (p2 §7.1, security.md — validate at
 * the boundary). Composable validators parse `unknown` into typed values and
 * throw {@link ValidationError} with a precise path on failure, so no untrusted
 * field ever reaches domain logic via an `as` cast.
 */

export type Validator<T> = (value: unknown, path: string) => T;

function failAt(path: string, expected: string, value: unknown): never {
  const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  throw new ValidationError(`${path}: expected ${expected}, got ${got}`);
}

export const v = {
  string(opts: { min?: number; max?: number; pattern?: RegExp } = {}): Validator<string> {
    return (value, path) => {
      if (typeof value !== "string") return failAt(path, "string", value);
      if (opts.min !== undefined && value.length < opts.min) throw new ValidationError(`${path}: shorter than ${opts.min}`);
      if (opts.max !== undefined && value.length > opts.max) throw new ValidationError(`${path}: longer than ${opts.max}`);
      if (opts.pattern && !opts.pattern.test(value)) throw new ValidationError(`${path}: does not match ${opts.pattern}`);
      return value;
    };
  },

  number(opts: { min?: number; max?: number; int?: boolean } = {}): Validator<number> {
    return (value, path) => {
      if (typeof value !== "number" || Number.isNaN(value)) return failAt(path, "number", value);
      if (opts.int && !Number.isInteger(value)) throw new ValidationError(`${path}: must be an integer`);
      if (opts.min !== undefined && value < opts.min) throw new ValidationError(`${path}: below minimum ${opts.min}`);
      if (opts.max !== undefined && value > opts.max) throw new ValidationError(`${path}: above maximum ${opts.max}`);
      return value;
    };
  },

  boolean(): Validator<boolean> {
    return (value, path) => (typeof value === "boolean" ? value : failAt(path, "boolean", value));
  },

  /** A non-negative integer expressed as a decimal string (on-chain amounts / motes). */
  bigintString(): Validator<string> {
    return (value, path) => {
      if (typeof value !== "string" || !/^\d+$/.test(value)) return failAt(path, "integer string", value);
      return value;
    };
  },

  /** A decimal money string like "100.00". */
  decimalString(): Validator<string> {
    return (value, path) => {
      if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return failAt(path, "decimal string", value);
      return value;
    };
  },

  literalUnion<T extends string>(...allowed: T[]): Validator<T> {
    return (value, path) => {
      if (typeof value === "string" && (allowed as string[]).includes(value)) return value as T;
      throw new ValidationError(`${path}: must be one of ${allowed.join(" | ")}`);
    };
  },

  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path) => (value === undefined || value === null ? undefined : inner(value, path));
  },

  withDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
    return (value, path) => (value === undefined || value === null ? fallback : inner(value, path));
  },

  array<T>(item: Validator<T>, opts: { max?: number } = {}): Validator<T[]> {
    return (value, path) => {
      if (!Array.isArray(value)) return failAt(path, "array", value);
      if (opts.max !== undefined && value.length > opts.max) throw new ValidationError(`${path}: more than ${opts.max} items`);
      return value.map((x, i) => item(x, `${path}[${i}]`));
    };
  },

  object<S extends Record<string, Validator<unknown>>>(schema: S): Validator<{ [K in keyof S]: ReturnType<S[K]> }> {
    return (value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return failAt(path, "object", value);
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(schema)) {
        out[key] = schema[key]!(obj[key], path ? `${path}.${key}` : key);
      }
      return out as { [K in keyof S]: ReturnType<S[K]> };
    };
  },
};

/** Parse a request body against a schema, throwing ValidationError on mismatch. */
export function parse<T>(schema: Validator<T>, body: unknown): T {
  return schema(body, "");
}
