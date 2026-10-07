// Attempt evaluation (SPEC §4) minus the grader (needs HTTP; see router.ts).
// Mirrors python/edgeworks_router/validators.py (parity source of truth).
import type { CommandRunner, ContentBlock, CustomValidator, CustomValidatorResult, Message, ValidatorSpec } from "./types.js";
import { validateSchema } from "./schema.js";
import { compileRegex } from "./regex.js";

export const FAIL_STOP_REASONS: ReadonlySet<string> = new Set(["max_tokens", "refusal", "model_context_window_exceeded", "pause_turn"]);

/** Built-in custom validators (present in BOTH languages). */
export const BUILTIN_VALIDATORS: Record<string, CustomValidator> = {
  /** Fails iff step == 1 (forces escalation for smoke tests) -> reason "custom:fail_on_step_1:step_1". */
  fail_on_step_1: (_output, ctx) => (ctx.step === 1 ? [false, "step_1"] : [true, null]),
};

export interface EvalResult {
  passed: boolean;
  /** failure first, then notes, joined "; " (null when passed without notes) */
  reason: string | null;
  notes: string[];
  /** 0..1 for best-attempt selection (pass = 1) */
  score: number;
  output: unknown;
  text: string;
}

/** text = all text blocks joined by "\n", trimmed; tool_uses = tool_use blocks. Never content[0]. */
export function extract(message: Message | null | undefined): { text: string; toolUses: ContentBlock[] } {
  const texts: string[] = [];
  const toolUses: ContentBlock[] = [];
  for (const b of Array.isArray(message?.content) ? message!.content : []) {
    if (!b) continue;
    if (b.type === "text") texts.push(typeof b.text === "string" ? b.text : "");
    else if (b.type === "tool_use") toolUses.push(b);
  }
  return { text: texts.join("\n").trim(), toolUses };
}

export function extractText(message: Message | null | undefined): string {
  return extract(message).text;
}

/** Strip ``` fences anywhere in the string; first fenced block wins (Python _FENCE). */
export function stripFences(s: string): string {
  const t = s.trim();
  const m = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/.exec(t);
  return m ? (m[1] ?? "").trim() : t;
}

export function parseJsonLoose(s: string, extractKind: "array" | "object" | null | undefined): { ok: true; value: unknown } | { ok: false } {
  let body = stripFences(s);
  if (extractKind === "array" || extractKind === "object") {
    const open = extractKind === "array" ? "[" : "{";
    const close = extractKind === "array" ? "]" : "}";
    const a = body.indexOf(open);
    const b = body.lastIndexOf(close);
    if (a < 0 || b < a) return { ok: false };
    body = body.slice(a, b + 1);
  }
  try {
    return { ok: true, value: JSON.parse(body) }; // JSON.parse already rejects NaN/Infinity
  } catch {
    return { ok: false };
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeCustom(r: CustomValidatorResult): [boolean, string | null] {
  if (typeof r === "boolean") return [r, null];
  if (Array.isArray(r)) return [Boolean(r[0]), r[1] ?? null];
  return [Boolean(r.ok), r.reason ?? null];
}

export interface EvalDeps {
  validators: Record<string, CustomValidator>;
  commandRunner?: CommandRunner;
}

/** A validator counts as deterministic unless it is a custom one that is unavailable in this process. */
export function isDeterministic(v: ValidatorSpec, deps: EvalDeps): boolean {
  return !(v.type === "custom" && !Object.prototype.hasOwnProperty.call(deps.validators, v.name));
}

/** Grader only when the pipeline has no deterministic validators (Python _grader_applies). */
export function graderEligible(validators: ValidatorSpec[], deps: EvalDeps): boolean {
  return !validators.some((v) => isDeterministic(v, deps));
}

function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export async function evaluateAttempt(message: Message, validators: ValidatorSpec[], step: number, deps: EvalDeps): Promise<EvalResult> {
  const { text, toolUses } = extract(message);
  const sr = message?.stop_reason ?? null;
  if (sr !== null && FAIL_STOP_REASONS.has(sr)) return { passed: false, reason: `stop_reason:${sr}`, notes: [], score: 0, output: text, text };
  if (text.length === 0 && toolUses.length === 0) return { passed: false, reason: "empty", notes: [], score: 0, output: text, text };

  let output: unknown = text;
  const notes: string[] = [];
  const total = validators.length;
  let passedN = 0;
  const done = (ok: boolean, failure: string | null): EvalResult => {
    const parts = [...(failure ? [failure] : []), ...notes];
    return {
      passed: ok,
      reason: parts.length ? parts.join("; ") : null,
      notes,
      score: ok ? 1 : total ? passedN / total : 0,
      output,
      text,
    };
  };

  for (const v of validators) {
    switch (v.type) {
      case "tool_use": {
        const hit = toolUses.find((b) => b.name === v.name);
        if (!hit) return done(false, `tool_use_missing:${v.name}`);
        output = hit.input;
        break;
      }
      case "json": {
        if (typeof output === "string") {
          const r = parseJsonLoose(output, v.extract ?? null);
          if (!r.ok) return done(false, "json_parse");
          output = r.value;
        }
        break;
      }
      case "json_schema": {
        const f = validateSchema(output, v.schema ?? {});
        if (f) return done(false, `schema:${f.pointer}:${f.keyword}`);
        break;
      }
      case "required_fields": {
        const objs = Array.isArray(output) ? output : [output];
        for (const f of v.fields ?? []) {
          for (const o of objs) {
            if (!isObj(o) || !Object.prototype.hasOwnProperty.call(o, f)) return done(false, `required_fields:${f}`);
          }
        }
        break;
      }
      case "length": {
        const n = cpLen(text);
        if ((v.min !== null && v.min !== undefined && n < v.min) || (v.max !== null && v.max !== undefined && n > v.max)) {
          return done(false, "length");
        }
        break;
      }
      case "regex": {
        const found = compileRegex(v.pattern ?? "").test(text);
        if (found !== ("must_match" in v ? Boolean(v.must_match) : true)) return done(false, "regex");
        break;
      }
      case "banned_phrases": {
        const ci = "case_insensitive" in v ? Boolean(v.case_insensitive) : true;
        const hay = ci ? text.toLowerCase() : text;
        for (const ph of v.phrases ?? []) {
          if (hay.includes(ci ? ph.toLowerCase() : ph)) return done(false, `banned_phrase:${ph}`);
        }
        break;
      }
      case "command": {
        // Node/Python only. In a runtime without a runner (browser/RN) it is noted, not failed.
        if (!deps.commandRunner) {
          notes.push("command:unavailable");
          break;
        }
        const code = await deps.commandRunner(v.cmd ?? [], output, text);
        if (code !== 0) return done(false, `command_exit:${code}`);
        break;
      }
      case "custom": {
        const fn = Object.prototype.hasOwnProperty.call(deps.validators, v.name) ? deps.validators[v.name] : undefined;
        if (!fn) {
          notes.push(`custom:${v.name}:unavailable`);
        } else {
          const [ok, why] = normalizeCustom(await fn(output, { step, message, text }));
          if (!ok) return done(false, `custom:${v.name}` + (why ? `:${why}` : ""));
        }
        break;
      }
      default:
        notes.push(`unknown_validator:${(v as { type?: string }).type}`);
    }
    passedN += 1;
  }
  return done(true, null);
}
