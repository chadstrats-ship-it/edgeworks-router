// Test helpers: spec §2 config, mocked fetch (sync + batch), fake sleep. NO live API calls.
import type { FetchInitLike, FetchLike, Message, PipelineConfig, RoutingConfig } from "../src/core/types.js";

export const TEST_KEY = "fake-test-key-do-not-log-123456";

export function makeConfig(pipelines: Record<string, PipelineConfig> = {}): RoutingConfig {
  return {
    version: 1,
    models: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", grader: "claude-haiku-4-5-20251001" },
    pricing: {
      sonnet: { input: 2.0, output: 10.0, cache_write_5m: 2.5, cache_read: 0.2 },
      opus: { input: 4.0, output: 20.0, cache_write_5m: 5.0, cache_read: 0.2 },
      haiku: { input: 1.0, output: 5.0, cache_write_5m: 1.25, cache_read: 0.1 },
    },
    model_pricing: {
      "claude-sonnet-5-5": "sonnet",
      "claude-sonnet-5": "sonnet",
      "claude-opus-5-5": "opus",
      "claude-haiku-4-5-20251001": "haiku",
      "claude-haiku-4-5": "haiku",
    },
    batch_discount: 0.5,
    defaults: {
      ladder: [
        { model: "sonnet", effort: "high" },
        { model: "opus", effort: "medium" },
        { model: "opus", effort: "xhigh", critical_only: true },
      ],
      max_attempts: 3,
      grader_threshold: 7,
      retry: { max_retries: 4, base_ms: 1000, max_ms: 30000 },
      batch_poll_seconds: 30,
    },
    report: { pin_escalation_rate: 0.4, pin_window: 50, medium_pass_rate: 0.95, medium_window: 100 },
    pipelines,
  };
}

export function pipe(p: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    description: "test",
    ladder: null,
    validators: [],
    grader: { enabled: false, threshold: 7, rubric: "" },
    max_attempts: 3,
    batchable: false,
    critical: false,
    pinned_model: null,
    ...p,
  };
}

export function msg(model: string, text: string | null, usage: Partial<Message["usage"]> = {}, stop_reason = "end_turn", extra: Message["content"] = []): Message {
  const content: Message["content"] = [];
  if (text !== null) content.push({ type: "text", text });
  content.push(...extra);
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    stop_reason,
    content,
    usage: { input_tokens: 10, output_tokens: 10, ...usage },
  };
}

export interface MockResp {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: Error;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

class Headers {
  constructor(private h: Record<string, string>) {}
  get(name: string): string | null {
    const k = Object.keys(this.h).find((x) => x.toLowerCase() === name.toLowerCase());
    return k === undefined ? null : (this.h[k] ?? null);
  }
}

function respond(r: MockResp) {
  if (r.throws) throw r.throws;
  const status = r.status ?? 200;
  const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
  return { status, ok: status >= 200 && status < 300, headers: new Headers(r.headers ?? {}), text: async () => text };
}

/** Sequential mock for POST /v1/messages. Each entry is a Message (200) or MockResp. */
export function mockFetch(queue: Array<Message | MockResp>): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const q = [...queue];
  const fetch: FetchLike = async (url: string, init: FetchInitLike) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined });
    const next = q.shift();
    if (next === undefined) throw new Error(`mockFetch: unexpected call #${calls.length} to ${url}`);
    const r: MockResp = "content" in (next as object) && "stop_reason" in (next as object) ? { status: 200, body: next } : (next as MockResp);
    return respond(r);
  };
  return { fetch, calls };
}

export type BatchResultFn = (args: { round: number; custom_id: string; params: any }) =>
  | { type: "succeeded"; message: Message }
  | { type: "errored" | "expired" | "canceled"; error?: unknown };

/**
 * Batch API mock: POST /v1/messages/batches, GET /v1/messages/batches/:id (in_progress once, then ended),
 * GET results_url (JSONL, REVERSED order to prove matching by custom_id). Also serves POST /v1/messages
 * from `syncQueue` (grader calls).
 */
export function mockBatchFetch(resultFor: BatchResultFn, syncQueue: Array<Message | MockResp> = []) {
  const calls: RecordedCall[] = [];
  const batches: Array<{ id: string; requests: any[]; polls: number }> = [];
  const sync = mockFetch(syncQueue);
  const fetch: FetchLike = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers: { ...init.headers }, body });
    if (init.method === "POST" && url.endsWith("/v1/messages/batches")) {
      const id = `msgbatch_${batches.length + 1}`;
      batches.push({ id, requests: body.requests, polls: 0 });
      return respond({ body: { id, type: "message_batch", processing_status: "in_progress" } });
    }
    let m = /\/v1\/messages\/batches\/([^/]+)\/results$/.exec(url);
    if (m) {
      const round = batches.findIndex((b) => b.id === m![1]);
      const b = batches[round]!;
      const lines = b.requests.map((r) => JSON.stringify({ custom_id: r.custom_id, result: resultFor({ round, custom_id: r.custom_id, params: r.params }) }));
      return respond({ body: lines.reverse().join("\n") + "\n" });
    }
    m = /\/v1\/messages\/batches\/([^/]+)$/.exec(url);
    if (m && init.method === "GET") {
      const b = batches.find((x) => x.id === m![1])!;
      b.polls++;
      const ended = b.polls >= 2;
      return respond({
        body: {
          id: b.id,
          processing_status: ended ? "ended" : "in_progress",
          results_url: ended ? `https://api.anthropic.com/v1/messages/batches/${b.id}/results` : null,
        },
      });
    }
    if (url.endsWith("/v1/messages")) return sync.fetch(url, init);
    throw new Error(`mockBatchFetch: unexpected ${init.method} ${url}`);
  };
  return { fetch, calls, batches, syncCalls: sync.calls };
}

export function fakeSleep() {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

export const USER_PARAMS = { max_tokens: 100, messages: [{ role: "user", content: "x" }] };

/** get a dotted/indexed path like "tools[0].input_schema.additionalProperties" */
export function getPath(obj: any, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}
