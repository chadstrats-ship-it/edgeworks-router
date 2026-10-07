// Request adaptation (SPEC §3) + strict-tool schema sanitizer.
// Mirrors python/edgeworks_router/adapt.py + schema.py (Python is the parity source of truth).
//
// Strict sanitizer rules from https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// (fetched 2026-09-28), "JSON Schema limitations":
//   Not supported: numerical constraints (minimum, maximum, multipleOf), string constraints (minLength,
//   maxLength), array constraints beyond minItems of 0 or 1, additionalProperties other than false.
//   Supported string formats: date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid.
//   Regex NOT supported: backreferences (\1), lookahead/lookbehind, \b \B, complex {n,m} with large ranges.
// The ORIGINAL schema is never mutated (deep clone); local json_schema validators keep every constraint.
import type { JsonObject, MessageParams } from "./types.js";
import { PrefillNotSupported } from "./errors.js";
import type { RoutingConfig } from "./types.js";
import { isHaikuModel } from "./config.js";

export const STRICT_SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  "date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid",
]);

/** Always removed from strict schemas (order matters: it is the order of `strict_strip:` adaptations). */
export const STRICT_ALWAYS_STRIP = [
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength",
  "maxItems", "uniqueItems", "contains", "minContains", "maxContains",
  "minProperties", "maxProperties",
] as const;

const LARGE_QUANTIFIER = 100;
const BAD_REGEX = /\\[1-9]|\(\?<?[=!]|\\[bB]/;
const QUANT = /\{(\d+)(?:,(\d*))?\}/g;
const MAP_KEYS = ["properties", "$defs", "definitions", "$def"] as const;
const LIST_KEYS = ["anyOf", "allOf", "oneOf", "prefixItems"] as const;
const ONE_KEYS = ["items", "not", "if", "then", "else"] as const;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ptrEscape(t: string): string {
  return String(t).replace(/~/g, "~0").replace(/\//g, "~1");
}

function patternUnsupported(p: string): boolean {
  if (BAD_REGEX.test(p)) return true;
  for (const m of p.matchAll(QUANT)) {
    const nums = [m[1], m[2]].filter((x): x is string => x !== undefined && x !== "").map(Number);
    if (nums.some((n) => n > LARGE_QUANTIFIER)) return true;
  }
  return false;
}

function isObjectSchema(s: JsonObject): boolean {
  const t = s.type;
  return t === "object" || (Array.isArray(t) && t.includes("object")) || "properties" in s;
}

function sanitize(s: unknown, path: string, stripped: string[]): void {
  if (!isPlainObject(s)) return;
  for (const kw of STRICT_ALWAYS_STRIP) {
    if (kw in s) {
      delete s[kw];
      stripped.push(`${path}/${kw}`);
    }
  }
  if ("minItems" in s && s.minItems !== 0 && s.minItems !== 1) {
    delete s.minItems;
    stripped.push(`${path}/minItems`);
  }
  if ("format" in s && !STRICT_SUPPORTED_FORMATS.has(s.format as string)) {
    delete s.format;
    stripped.push(`${path}/format`);
  }
  if (typeof s.pattern === "string" && patternUnsupported(s.pattern)) {
    delete s.pattern;
    stripped.push(`${path}/pattern`);
  }
  if (isObjectSchema(s)) {
    if ("additionalProperties" in s && s.additionalProperties !== false) stripped.push(`${path}/additionalProperties`);
    s.additionalProperties = false;
  }
  for (const key of MAP_KEYS) {
    const m = s[key];
    if (isPlainObject(m)) for (const [name, sub] of Object.entries(m)) sanitize(sub, `${path}/${key}/${ptrEscape(name)}`, stripped);
  }
  for (const key of LIST_KEYS) {
    const lst = s[key];
    if (Array.isArray(lst)) lst.forEach((sub, i) => sanitize(sub, `${path}/${key}/${i}`, stripped));
  }
  for (const key of ONE_KEYS) {
    const sub = s[key];
    if (isPlainObject(sub)) sanitize(sub, `${path}/${key}`, stripped);
    else if (key === "items" && Array.isArray(sub)) sub.forEach((x, i) => sanitize(x, `${path}/items/${i}`, stripped));
  }
}

/**
 * Deep-copies `schema`, forces additionalProperties:false on every object schema and strips keywords
 * unsupported by strict tool use / structured outputs. `stripped` entries are `<schema-pointer>/<keyword>`.
 */
export function sanitizeStrictSchema(schema: unknown): { schema: unknown; stripped: string[] } {
  const out = clone(schema);
  const stripped: string[] = [];
  sanitize(out, "", stripped);
  return { schema: out, stripped };
}

/** SPEC §3.5 — raise before anything is sent/saved. */
export function assertNoPrefill(params: MessageParams | JsonObject): void {
  const msgs = (params as JsonObject)?.messages;
  if (Array.isArray(msgs) && msgs.length > 0 && msgs[msgs.length - 1]?.role === "assistant") {
    throw new PrefillNotSupported(
      "last message has role 'assistant' (prefill) - not supported on Sonnet 5.5 / Opus 5.5; restructure the prompt instead",
    );
  }
}

/** Payload form: call-site params minus `model`, with header/key-like fields scrubbed. */
export function originalParams(params: MessageParams | JsonObject): JsonObject {
  const p = clone(params) as JsonObject;
  delete p.model;
  for (const k of Object.keys(p)) {
    const lk = k.toLowerCase();
    if (["extra_headers", "headers", "api_key", "x-api-key", "authorization"].includes(lk) || lk.includes("api_key")) delete p[k];
  }
  return p;
}

export interface AdaptResult {
  body: JsonObject;
  adaptations: string[];
}

/**
 * SPEC §3: outgoing body for `modelId`/`effort` from the call-site's ORIGINAL params. Pure: never mutates
 * `params`. Throws PrefillNotSupported.
 */
export function adaptRequest(config: RoutingConfig, params: JsonObject, modelId: string, effort: string | null): AdaptResult {
  assertNoPrefill(params);
  const sent = clone(params) as JsonObject;
  const adaptations: string[] = [];

  // 1. model + effort (never effort to Haiku)
  sent.model = modelId;
  const haiku = isHaikuModel(config, modelId);
  const oc: JsonObject = isPlainObject(sent.output_config) ? { ...sent.output_config } : {};
  if (haiku) {
    if ("effort" in oc) {
      delete oc.effort;
      adaptations.push("effort_removed_haiku");
    }
  } else if (effort !== null && effort !== undefined) {
    oc.effort = effort;
  }
  if (Object.keys(oc).length > 0) sent.output_config = oc;
  else delete sent.output_config;

  // 2. forced tool use -> auto + strict
  const tc = sent.tool_choice;
  const tools = sent.tools;
  if (isPlainObject(tc) && (tc.type === "tool" || tc.type === "any") && Array.isArray(tools)) {
    const forcedName = tc.type === "tool" ? tc.name : null;
    const newTc: JsonObject = { type: "auto" };
    if ("disable_parallel_tool_use" in tc) newTc.disable_parallel_tool_use = tc.disable_parallel_tool_use;
    sent.tool_choice = newTc;
    for (const t of tools) {
      if (!isPlainObject(t) || !("input_schema" in t)) continue; // server tools have no input_schema
      if (forcedName === null || t.name === forcedName) t.strict = true;
    }
    adaptations.push("forced_tool_use->auto_strict");
  }
  // every strict tool (router-marked or call-site-marked) gets a sanitized schema
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (isPlainObject(t) && t.strict === true && isPlainObject(t.input_schema)) {
        const r = sanitizeStrictSchema(t.input_schema);
        t.input_schema = r.schema;
        for (const s of r.stripped) adaptations.push(`strict_strip:${String(t.name)}${s}`);
      }
    }
  }
  const fmt = isPlainObject(sent.output_config) ? sent.output_config.format : undefined;
  if (isPlainObject(fmt) && isPlainObject(fmt.schema)) {
    const r = sanitizeStrictSchema(fmt.schema);
    (sent.output_config as JsonObject).format = { ...fmt, schema: r.schema };
    for (const s of r.stripped) adaptations.push(`strict_strip:output_format${s}`);
  }

  // 3. sampling params
  if ("temperature" in sent && sent.temperature !== 1) {
    delete sent.temperature;
    adaptations.push("temperature_removed");
  }
  if ("top_k" in sent) {
    delete sent.top_k;
    adaptations.push("top_k_removed");
  }
  if ("top_p" in sent && sent.top_p !== null && sent.top_p !== undefined && sent.top_p < 0.99) {
    delete sent.top_p;
    adaptations.push("top_p_removed");
  }

  // 4. thinking
  if (isPlainObject(sent.thinking)) {
    if (sent.thinking.type === "disabled") {
      sent.thinking = { type: "between_tools" };
      adaptations.push("thinking_disabled->between_tools");
    } else if (sent.thinking.type === "enabled") {
      sent.thinking = { type: "adaptive" };
      adaptations.push("thinking_enabled->adaptive");
    }
  }

  // router is non-streaming
  if ("stream" in sent) {
    const was = sent.stream;
    delete sent.stream;
    if (was) adaptations.push("stream_removed");
  }
  return { body: sent, adaptations };
}
