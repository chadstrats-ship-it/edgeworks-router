// Zero-dependency JSON Schema subset validator (SPEC §4 json_schema):
// type (incl. arrays of types), required, properties, additionalProperties (bool), items, enum,
// minimum, maximum, minLength, maxLength, minItems, maxItems, pattern.
// Returns null on success or `{pointer, keyword}` of the FIRST failure (instance JSON pointer, RFC 6901).
import type { JsonObject } from "./types.js";
import { compileRegex } from "./regex.js";

export interface SchemaFailure {
  pointer: string;
  keyword: string;
}

function esc(seg: string | number): string {
  return String(seg).replace(/~/g, "~0").replace(/\//g, "~1");
}

function typeMatches(value: unknown, t: string): boolean {
  switch (t) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false; // unknown type keyword never matches (Python _is_type)
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

/** Code-point length (matches Python len()). */
function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function validateSchema(value: unknown, schema: JsonObject, pointer = ""): SchemaFailure | null {
  if (typeof schema !== "object" || schema === null) return null;
  const fail = (keyword: string, p: string = pointer): SchemaFailure => ({ pointer: p, keyword });

  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) return fail("type");
  }
  if ("enum" in schema && Array.isArray(schema.enum)) {
    if (!schema.enum.some((e: unknown) => deepEqual(e, value))) return fail("enum");
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return fail("minimum");
    if (typeof schema.maximum === "number" && value > schema.maximum) return fail("maximum");
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && cpLen(value) < schema.minLength) return fail("minLength");
    if (typeof schema.maxLength === "number" && cpLen(value) > schema.maxLength) return fail("maxLength");
    if (typeof schema.pattern === "string") {
      if (!compileRegex(schema.pattern).test(value)) return fail("pattern");
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return fail("minItems");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return fail("maxItems");
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const f = validateSchema(value[i], schema.items, `${pointer}/${i}`);
        if (f) return f;
      }
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(obj, r)) return fail("required");
      }
    }
    const props: JsonObject | undefined =
      schema.properties && typeof schema.properties === "object" ? schema.properties : undefined;
    if (props) {
      for (const [k, sub] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          const f = validateSchema(obj[k], sub as JsonObject, `${pointer}/${esc(k)}`);
          if (f) return f;
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!props || !Object.prototype.hasOwnProperty.call(props, k)) return fail("additionalProperties");
      }
    }
  }
  return null;
}
