// SDK-free Messages API transport with infra retry (SPEC §5): same model, full-jitter backoff,
// honors retry-after when larger. Never logs or returns the API key.
import type { FetchLike, FetchResponseLike } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Per-request timeout (Python DEFAULT_REQUEST_TIMEOUT_S = 900). */
export const DEFAULT_TIMEOUT_MS = 900_000;

export interface RetryPolicy {
  max_retries: number;
  base_ms: number;
  max_ms: number;
}

export interface HttpDeps {
  fetch: FetchLike;
  apiKey?: string;
  baseUrl: string;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
  retry: RetryPolicy;
}

/** Internal failure carrier; router.ts converts to RouterInfraError / RouterRequestError after logging. */
export class CallFailure extends Error {
  constructor(
    readonly kind: "infra" | "request",
    /** infra: http status | "timeout" | "network"; request: http status */
    readonly code: string,
    readonly status: number | null,
    readonly retries: number,
    readonly latencyMs: number,
    readonly body: string | null,
  ) {
    super(`${kind}:${code}`);
    this.name = "CallFailure";
  }
}

export interface CallOk<T> {
  data: T;
  latencyMs: number;
  retries: number;
}

type G = {
  AbortController?: new () => { signal: unknown; abort(): void };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  fetch?: FetchLike;
};
const g = globalThis as unknown as G;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (g.setTimeout) g.setTimeout(resolve, ms);
    else resolve();
  });
}

export function defaultFetch(): FetchLike | undefined {
  return typeof g.fetch === "function" ? (g.fetch.bind(globalThis) as FetchLike) : undefined;
}

/** Same classification as Python classify_error: 408, 429, 529, any 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 529 || status >= 500;
}

export function parseRetryAfterMs(h: FetchResponseLike["headers"] | undefined, nowMs: number): number | null {
  if (!h || typeof h.get !== "function") return null;
  const ms = h.get("retry-after-ms");
  if (ms !== null && ms !== undefined && ms.trim() !== "" && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const v = h.get("retry-after");
  if (v === null || v === undefined || v.trim() === "") return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const d = Date.parse(v);
  if (Number.isFinite(d)) return Math.max(0, d - nowMs);
  return null;
}

/** delay = min(max_ms, base_ms * 2^n) * U(0.5, 1.0), or retry-after if larger. */
export function backoffMs(policy: RetryPolicy, n: number, random: () => number, retryAfterMs: number | null): number {
  const base = Math.min(policy.max_ms, policy.base_ms * Math.pow(2, n));
  const jittered = base * (0.5 + 0.5 * random());
  return retryAfterMs !== null && retryAfterMs > jittered ? retryAfterMs : jittered;
}

export function buildHeaders(apiKey: string | undefined, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      const lk = k.toLowerCase();
      if (lk === "x-api-key" || lk === "anthropic-version" || lk === "content-type") continue;
      h[lk] = v;
    }
  }
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

/**
 * One logical API call with infra retry on the same target. Resolves parsed JSON (or raw text when
 * `raw`); throws CallFailure.
 */
export async function callApi<T = unknown>(
  deps: HttpDeps,
  method: "GET" | "POST",
  pathOrUrl: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs?: number; raw?: boolean; beforeAttempt?: () => Promise<void> } = {},
): Promise<CallOk<T>> {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${deps.baseUrl.replace(/\/+$/, "")}${pathOrUrl}`;
  const headers = buildHeaders(deps.apiKey, opts.headers);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let retries = 0;
  for (;;) {
    // spend cap is checked before EVERY live call, including retries (Python _send parity)
    if (opts.beforeAttempt) await opts.beforeAttempt();
    const start = deps.now();
    let code: string;
    let status: number | null = null;
    let retryAfter: number | null = null;
    let errBody: string | null = null;
    let timer: unknown;
    const ac = g.AbortController ? new g.AbortController() : undefined;
    let timedOut = false;
    try {
      if (ac && g.setTimeout) {
        timer = g.setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, timeoutMs);
      }
      const init: { method: string; headers: Record<string, string>; body?: string; signal?: unknown } = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      if (ac) init.signal = ac.signal;
      const res = await deps.fetch(url, init);
      const text = await res.text();
      const latencyMs = Math.max(0, Math.round(deps.now() - start));
      if (res.status >= 200 && res.status < 300) {
        if (opts.raw) return { data: text as unknown as T, latencyMs, retries };
        try {
          return { data: JSON.parse(text) as T, latencyMs, retries };
        } catch {
          code = "bad_json";
          errBody = text.slice(0, 2000);
          status = res.status;
        }
      } else {
        status = res.status;
        errBody = text.slice(0, 2000);
        if (!isRetryableStatus(res.status)) {
          throw new CallFailure("request", String(res.status), res.status, retries, latencyMs, errBody);
        }
        code = String(res.status);
        retryAfter = parseRetryAfterMs(res.headers, deps.now());
      }
    } catch (e) {
      if (e instanceof CallFailure) throw e;
      code = timedOut ? "timeout" : "network";
      errBody = e instanceof Error ? e.message : String(e);
    } finally {
      if (timer !== undefined && g.clearTimeout) g.clearTimeout(timer);
    }
    const latencyMs = Math.max(0, Math.round(deps.now() - start));
    if (retries >= deps.retry.max_retries) {
      throw new CallFailure("infra", code, status, retries, latencyMs, errBody);
    }
    await deps.sleep(backoffMs(deps.retry, retries, deps.random, retryAfter));
    retries++;
  }
}
