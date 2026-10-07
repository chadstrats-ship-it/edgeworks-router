// Core types for @edgeworks/router. Browser/React-Native safe: no node imports, no DOM lib.
// Contract: edgeworks-router/SPEC.md (shared with the Python implementation).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = Record<string, any>;

// ---------------------------------------------------------------- routing.json

export interface PricingEntry {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_read: number;
}

export interface LadderStep {
  /** alias key of `models` (e.g. "sonnet") or a literal model id */
  model: string;
  /** output_config.effort; null = omit (model API default) */
  effort?: string | null;
  critical_only?: boolean;
}

export type ValidatorSpec =
  | { type: "tool_use"; name: string }
  | { type: "json"; extract?: "array" | "object" | null }
  | { type: "json_schema"; schema: JsonObject }
  | { type: "required_fields"; fields: string[] }
  | { type: "length"; min?: number | null; max?: number | null }
  | { type: "regex"; pattern: string; must_match?: boolean }
  | { type: "banned_phrases"; phrases: string[]; case_insensitive?: boolean }
  | { type: "command"; cmd: string[] }
  | { type: "custom"; name: string };

export interface GraderConfig {
  enabled: boolean;
  threshold?: number | null;
  rubric?: string | null;
}

export interface PipelineConfig {
  description?: string;
  ladder?: LadderStep[] | null;
  validators?: ValidatorSpec[];
  grader?: GraderConfig | null;
  max_attempts?: number | null;
  batchable?: boolean;
  critical?: boolean;
  pinned_model?: string | null;
}

export interface RoutingConfig {
  version: number;
  models: Record<string, string>;
  pricing: Record<string, PricingEntry>;
  model_pricing: Record<string, string>;
  batch_discount: number;
  defaults: {
    ladder: LadderStep[];
    max_attempts: number;
    grader_threshold: number;
    retry: { max_retries: number; base_ms: number; max_ms: number };
    batch_poll_seconds: number;
  };
  report?: {
    pin_escalation_rate: number;
    pin_window: number;
    medium_pass_rate: number;
    medium_window: number;
  };
  pipelines: Record<string, PipelineConfig>;
}

/** A ladder step resolved against config: concrete model id, 1-based index into the effective ladder. */
export interface ResolvedStep {
  step: number;
  alias: string | null;
  model: string;
  effort: string | null;
}

// ---------------------------------------------------------------- Messages API (structural, SDK-free)

export interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  [k: string]: unknown;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}

/** Raw Messages API response JSON (plain object). */
export interface Message {
  id?: string;
  type?: string;
  role?: string;
  model: string;
  stop_reason: string | null;
  content: ContentBlock[];
  usage: MessageUsage;
  [k: string]: unknown;
}

/** Messages API request params as passed by the call site (`model` optional/ignored — the router sets it). */
export type MessageParams = JsonObject & {
  messages: Array<{ role: string; content: unknown }>;
  max_tokens: number;
  model?: string;
};

// ---------------------------------------------------------------- fetch (structural)

export interface FetchResponseLike {
  status: number;
  ok?: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

// ---------------------------------------------------------------- logging / sinks

export type LogRole = "attempt" | "grader" | "rejection";

export interface LogLine {
  timestamp: string;
  task_id: string;
  pipeline: string;
  /** null on role "rejection" lines */
  step: number | null;
  requested_model: string | null;
  served_model: string | null;
  effort: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  latency_ms: number;
  validation_passed: boolean;
  validation_reason: string | null;
  escalated: boolean;
  final: boolean;
  batch: boolean;
  role: LogRole;
  status?: string;
  stop_reason: string | null;
  retries: number;
  model_mismatch: boolean;
  human_rejected: boolean;
  rejected_task_id?: string;
  adaptations: string[];
  lang: "ts" | "py";
  [k: string]: unknown;
}

export interface PayloadRecord {
  task_id: string;
  pipeline: string;
  lang: "ts" | "py";
  created: string;
  params: JsonObject;
}

type MaybePromise<T> = T | Promise<T>;

/** Pluggable persistence. Only writeLine/savePayload/totalSpend are required (SPEC §6). */
export interface RouterSink {
  writeLine(line: LogLine): MaybePromise<void>;
  savePayload(taskId: string, payload: PayloadRecord): MaybePromise<void>;
  /** Total cost_usd across all log lines (spend cap). */
  totalSpend(): MaybePromise<number>;
  /** Needed by reject(). */
  loadPayload?(taskId: string): MaybePromise<PayloadRecord | null>;
  /** Persist a reject re-run result (node: logs/rejections/<id>.json). */
  saveRejection?(taskId: string, result: RouteResult): MaybePromise<void>;
}

// ---------------------------------------------------------------- validators

export interface ValidatorContext {
  step: number;
  message: Message;
  text: string;
}

export type CustomValidatorResult =
  | [boolean, (string | null | undefined)?]
  | { ok: boolean; reason?: string | null }
  | boolean;

export type CustomValidator = (output: unknown, ctx: ValidatorContext) => MaybePromise<CustomValidatorResult>;

/** Runs a `command` validator (Node only). Returns process exit code. */
export type CommandRunner = (cmd: string[], output: unknown, text: string) => Promise<number>;

// ---------------------------------------------------------------- results

export type RouteStatus = "passed" | "escalated_passed" | "failed_all";

export interface AttemptSummary {
  step: number;
  model: string;
  effort: string | null;
  passed: boolean;
  reason: string | null;
  cost_usd: number;
}

export interface RouteResult {
  status: RouteStatus;
  task_id: string;
  final_step: number;
  message: Message;
  output: unknown;
  text: string;
  served_model: string;
  total_cost_usd: number;
  attempts: AttemptSummary[];
}

/** routeBatch() result: like RouteResult, but an item whose every attempt errored/expired has no message. */
export interface BatchRouteResult extends Omit<RouteResult, "message" | "served_model"> {
  message: Message | null;
  served_model: string | null;
  /** the item's custom_id (caller supplied, else derived from task_id) */
  custom_id: string;
}

export interface RouteOptions {
  /** Force a task id (default `<pipeline>-<yyyymmddHHMMSS>-<8 hex>`). */
  taskId?: string;
  /** Override pipeline.critical (enables critical_only ladder steps). */
  critical?: boolean;
  /** Extra request headers from the call site (e.g. anthropic-beta). Never added by the router itself. */
  headers?: Record<string, string>;
  /** Per-HTTP-request timeout in ms (default 900000, same as Python). */
  timeoutMs?: number;
}

export interface BatchItem {
  custom_id?: string;
  params: MessageParams;
}

export interface CreateRouterOptions {
  config: RoutingConfig;
  fetch?: FetchLike;
  sink?: RouterSink;
  apiKey?: string;
  /** Custom validators by name (merged over built-ins such as fail_on_step_1). */
  validators?: Record<string, CustomValidator>;
  /** Sleep used for retry backoff and batch polling (inject a fake in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in epoch ms (default Date.now). */
  now?: () => number;
  /** Uniform [0,1) RNG for jitter / ids (default Math.random). */
  random?: () => number;
  /** Hard spend cap in USD (node wrapper reads EDGEWORKS_ROUTER_SPEND_CAP_USD). */
  spendCapUsd?: number | null;
  /** API base URL (default https://api.anthropic.com). */
  baseUrl?: string;
  /** Runner for `command` validators (node wrapper supplies one). Absent → `command:unavailable` note. */
  commandRunner?: CommandRunner;
  /** Log `lang` field (default "ts"). */
  lang?: "ts" | "py";
}

export interface Router {
  route(pipeline: string, params: MessageParams, opts?: RouteOptions): Promise<RouteResult>;
  routeBatch(pipeline: string, items: BatchItem[], opts?: Omit<RouteOptions, "taskId">): Promise<BatchRouteResult[]>;
  reject(taskId: string, reason: string, opts?: Omit<RouteOptions, "taskId" | "critical">): Promise<RouteResult>;
}
