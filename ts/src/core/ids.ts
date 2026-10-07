// task ids + timestamps (SPEC §6). No node crypto: uses globalThis.crypto when present (RN may lack it).

type G = { crypto?: { getRandomValues?<T extends Uint8Array>(a: T): T } };
const g = globalThis as unknown as G;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** yyyymmddHHMMSS (UTC). */
export function compactUtc(ms: number): string {
  const d = new Date(ms);
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

/** ISO-8601 UTC with ms and Z. */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

export function randomHex(len: number, random: () => number = Math.random): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256) & 0xff;
  }
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s.slice(0, len);
}

export const CUSTOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Characters outside [A-Za-z0-9_-] -> "_" (Python _safe_name). */
export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `<safe pipeline>-<yyyymmddHHMMSS>-<8 hex>` (UTC). */
export function newTaskId(pipeline: string, nowMs: number, random?: () => number): string {
  return `${safeName(pipeline)}-${compactUtc(nowMs)}-${randomHex(8, random)}`;
}

/** Batch custom_id: the task_id, or (if > 64 chars) its pipeline prefix truncated so the unique
 *  24-char `-<timestamp>-<hex>` suffix is always kept (Python custom_id_for). */
export function customIdFor(taskId: string): string {
  const safe = safeName(taskId);
  if (safe.length <= 64) return safe;
  return safe.slice(0, 64 - 24) + safe.slice(-24);
}
