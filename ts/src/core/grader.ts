// Haiku grader request construction + response parsing (SPEC §4 Grader). Mirrors python router._evaluate.
import type { JsonObject, Message } from "./types.js";
import { extractText, parseJsonLoose } from "./evaluate.js";

/** Verbatim copy of python/edgeworks_router/router.py GRADER_SYSTEM_PROMPT. */
export const GRADER_SYSTEM_PROMPT =
  "You are a strict quality grader. You will receive a RUBRIC, the ORIGINAL REQUEST (user text only) and a " +
  "CANDIDATE RESPONSE. Score how well the candidate satisfies the rubric and the request on an integer scale " +
  "0-10 (10 = fully correct and complete, 0 = unusable). Respond with ONLY a JSON object, no prose, exactly: " +
  '{"score": <integer 0-10>, "reason": "<one short sentence>"}';

export const GRADER_MAX_TOKENS = 1024;

/** Text parts of all user messages (non-empty), joined with blank lines. */
export function userTextOf(params: JsonObject): string {
  const parts: string[] = [];
  const msgs = Array.isArray(params?.messages) ? params.messages : [];
  for (const m of msgs) {
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c) if (b && b.type === "text") parts.push(typeof b.text === "string" ? b.text : "");
    }
  }
  return parts.filter((p) => p).join("\n\n");
}

/** Grader params WITHOUT model (the caller runs them through adaptRequest like any other request). */
export function buildGraderParams(rubric: string, params: JsonObject, candidate: string): JsonObject {
  return {
    max_tokens: GRADER_MAX_TOKENS,
    system: GRADER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `RUBRIC:\n${rubric}\n\nORIGINAL REQUEST:\n${userTextOf(params)}\n\nCANDIDATE RESPONSE:\n${candidate}`,
      },
    ],
  };
}

/** Score 0..10 (number, not bool/string) or null when unparseable. */
export function parseGraderScore(msg: Message): number | null {
  const r = parseJsonLoose(extractText(msg), "object");
  if (!r.ok || typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) return null;
  const s = (r.value as Record<string, unknown>).score;
  if (typeof s === "number" && s >= 0 && s <= 10) return s;
  return null;
}

/** Python _fmt_num: integral -> "7", else "7.5". */
export function fmtNum(x: number): string {
  return Number.isInteger(x) ? String(Math.trunc(x)) : String(x);
}
