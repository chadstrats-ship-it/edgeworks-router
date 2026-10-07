// Routing loop (SPEC §5), logging (§6), batch mode (§7), reject re-run (§8). Browser/RN safe.
// Line-for-line behavioral mirror of python/edgeworks_router/router.py (parity source of truth).
import type {
  AttemptSummary,
  BatchItem,
  BatchRouteResult,
  CreateRouterOptions,
  CustomValidator,
  FetchLike,
  JsonObject,
  LogLine,
  Message,
  MessageParams,
  PipelineConfig,
  ResolvedStep,
  RouteOptions,
  RouteResult,
  Router,
  RouterSink,
} from "./types.js";
import { RouterConfigError, RouterInfraError, RouterRequestError, SpendCapExceeded } from "./errors.js";
import { computeCost, effectiveLadder, getPipeline, graderThreshold, isHaikuModel, isOpusModel, resolveModel, round6, usageTokens, type TokenCounts } from "./config.js";
import { adaptRequest, assertNoPrefill, originalParams } from "./adapt.js";
import { BUILTIN_VALIDATORS, evaluateAttempt, graderEligible, type EvalDeps, type EvalResult } from "./evaluate.js";
import { buildGraderParams, fmtNum, parseGraderScore } from "./grader.js";
import { CallFailure, DEFAULT_BASE_URL, callApi, defaultFetch, defaultSleep, type HttpDeps } from "./http.js";
import { CUSTOM_ID_RE, customIdFor, isoUtc, newTaskId } from "./ids.js";
import { noopSink } from "./sinks.js";

/** Per-task logging context (Python `extra`). */
interface RunCtx {
  taskId: string;
  pipelineName: string;
  pipeline: PipelineConfig;
  humanRejected: boolean;
  rejectedTaskId?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface Attempt extends AttemptSummary {
  served: string | null;
  score: number;
  message: Message | null;
  output: unknown;
  text: string;
}

interface LineInput {
  step: number | null;
  requested: string | null;
  served: string | null;
  effort: string | null;
  tokens: TokenCounts | null;
  cost: number;
  latency: number;
  passed: boolean;
  reason: string | null;
  escalated: boolean;
  final: boolean;
  batch: boolean;
  role: LogLine["role"];
  status?: string;
  stopReason: string | null;
  retries: number;
  modelMismatch: boolean;
  adaptations: string[];
}

const ZERO_TOKENS: TokenCounts = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

export function createRouter(options: CreateRouterOptions): Router {
  const config = options.config;
  if (!config || !config.defaults || !config.models || !config.pricing || !config.model_pricing || !config.pipelines) {
    throw new RouterConfigError("createRouter: config must contain models, pricing, model_pricing, defaults, pipelines");
  }
  const sink: RouterSink = options.sink ?? noopSink;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const lang = options.lang ?? "ts";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const registry: Record<string, CustomValidator> = { ...BUILTIN_VALIDATORS, ...(options.validators ?? {}) };
  const evalDeps: EvalDeps = options.commandRunner ? { validators: registry, commandRunner: options.commandRunner } : { validators: registry };
  const cap = typeof options.spendCapUsd === "number" && Number.isFinite(options.spendCapUsd) ? options.spendCapUsd : null;
  const defaultRetry = { max_retries: 4, base_ms: 1000, max_ms: 30000 };
  const retryCfg = { ...defaultRetry, ...((config.defaults.retry as Partial<typeof defaultRetry> | undefined) ?? {}) };

  function http(): HttpDeps {
    const f: FetchLike | undefined = options.fetch ?? defaultFetch();
    if (!f) throw new RouterConfigError("no fetch implementation available; pass createRouter({ fetch })");
    if (!options.apiKey && baseUrl === DEFAULT_BASE_URL) {
      throw new RouterConfigError("missing Anthropic API key (pass apiKey or set ANTHROPIC_API_KEY)");
    }
    const deps: HttpDeps = { fetch: f, baseUrl, sleep, random, now, retry: retryCfg };
    if (options.apiKey) deps.apiKey = options.apiKey;
    return deps;
  }

  async function checkSpend(): Promise<void> {
    if (cap === null) return;
    const total = Number(await sink.totalSpend());
    if (total >= cap) throw new SpendCapExceeded(total, cap);
  }

  function sentEffort(step: ResolvedStep): string | null {
    return isHaikuModel(config, step.model) ? null : step.effort;
  }

  function line(ctx: RunCtx, li: LineInput): LogLine {
    const t = li.tokens ?? ZERO_TOKENS;
    return {
      timestamp: isoUtc(now()),
      task_id: ctx.taskId,
      pipeline: ctx.pipelineName,
      step: li.step,
      requested_model: li.requested,
      served_model: li.served,
      effort: li.effort,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      cache_read_tokens: t.cache_read_tokens,
      cache_write_tokens: t.cache_write_tokens,
      cost_usd: round6(li.cost),
      latency_ms: Math.max(0, Math.trunc(li.latency)),
      validation_passed: li.passed,
      validation_reason: li.reason,
      escalated: li.escalated,
      final: li.final,
      batch: li.batch,
      role: li.role,
      ...(li.status !== undefined ? { status: li.status } : {}),
      stop_reason: li.stopReason,
      retries: li.retries,
      model_mismatch: li.modelMismatch,
      human_rejected: ctx.humanRejected,
      ...(ctx.rejectedTaskId ? { rejected_task_id: ctx.rejectedTaskId } : {}),
      adaptations: [...li.adaptations],
      lang,
    } as LogLine;
  }

  interface FailTemplate {
    ctx: RunCtx;
    step: ResolvedStep;
    adaptations: string[];
    batch: boolean;
  }

  function hopts(ctx: { headers?: Record<string, string>; timeoutMs?: number }) {
    return {
      ...(ctx.headers ? { headers: ctx.headers } : {}),
      ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
      beforeAttempt: checkSpend,
    };
  }

  /**
   * One API call with same-model infra retry (Python _send). On exhaustion / non-retryable: writes a
   * terminal line for each fail template, then raises RouterInfraError / RouterRequestError.
   */
  async function send<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    o: { headers?: Record<string, string>; timeoutMs?: number; raw?: boolean },
    failLines: FailTemplate[],
    taskId: string | null,
  ): Promise<{ data: T; retries: number; latencyMs: number }> {
    try {
      return await callApi<T>(http(), method, path, body, { ...hopts(o), ...(o.raw ? { raw: true } : {}) });
    } catch (e) {
      if (!(e instanceof CallFailure)) throw e;
      const retryable = e.kind === "infra";
      const reason = retryable ? `infra:${e.code}` : `http_${e.code}`;
      for (const tpl of failLines) {
        await sink.writeLine(
          line(tpl.ctx, {
            step: tpl.step.step,
            requested: tpl.step.model,
            served: null,
            effort: sentEffort(tpl.step),
            tokens: null,
            cost: 0,
            latency: e.latencyMs,
            passed: false,
            reason,
            escalated: false,
            final: true,
            batch: tpl.batch,
            role: "attempt",
            status: retryable ? "infra_error" : "request_error",
            stopReason: null,
            retries: e.retries,
            modelMismatch: false,
            adaptations: tpl.adaptations,
          }),
        );
      }
      if (retryable) {
        throw new RouterInfraError(`infra failure after ${e.retries} retries: ${e.code}`, { code: e.code, taskId, retries: e.retries });
      }
      throw new RouterRequestError(`request rejected by API: HTTP ${e.code}`, { status: e.status, taskId, body: e.body });
    }
  }

  /** Validators + optional Haiku grader (Python _evaluate). Returns evaluation and grader cost. */
  async function evaluate(ctx: RunCtx, step: ResolvedStep, message: Message, params: JsonObject): Promise<{ ev: EvalResult; gcost: number }> {
    const pcfg = ctx.pipeline;
    const ev = await evaluateAttempt(message, pcfg.validators ?? [], step.step, evalDeps);
    if (!ev.passed || !pcfg.grader?.enabled || !graderEligible(pcfg.validators ?? [], evalDeps)) return { ev, gcost: 0 };
    const threshold = graderThreshold(config, pcfg);
    const graderModel = resolveModel(config, "grader").model;
    const gparams = buildGraderParams(pcfg.grader.rubric ?? "", params, ev.text);
    const { body, adaptations } = adaptRequest(config, gparams, graderModel, null);
    let res: { data: Message; retries: number; latencyMs: number };
    try {
      res = await send<Message>("POST", "/v1/messages", body, ctx, [], ctx.taskId);
    } catch (e) {
      if (e instanceof RouterInfraError || e instanceof RouterRequestError) {
        const code = e instanceof RouterInfraError ? e.code : String(e.status);
        ev.reason = [`grader_error:infra_${code}`, ...ev.notes].join("; ");
        return { ev, gcost: 0 };
      }
      throw e;
    }
    const gmsg = res.data;
    const served = typeof gmsg?.model === "string" ? gmsg.model : null;
    const tokens = usageTokens(gmsg?.usage);
    const c = computeCost(config, served, graderModel, tokens, false);
    const score = parseGraderScore(gmsg);
    const gpass = score !== null && score >= threshold;
    await sink.writeLine(
      line(ctx, {
        step: step.step,
        requested: graderModel,
        served,
        effort: null,
        tokens,
        cost: c.cost_usd,
        latency: res.latencyMs,
        passed: gpass,
        reason: score !== null ? `grader:${fmtNum(score)}` : "grader_parse",
        escalated: false,
        final: false,
        batch: false,
        role: "grader",
        stopReason: gmsg?.stop_reason ?? null,
        retries: res.retries,
        modelMismatch: served !== null && served !== graderModel,
        adaptations: [...adaptations, ...c.notes],
      }),
    );
    if (score === null) {
      ev.reason = ["grader_error:parse", ...ev.notes].join("; ");
      return { ev, gcost: c.cost_usd };
    }
    if (score < threshold) {
      ev.passed = false;
      ev.reason = [`grader:${fmtNum(score)}`, ...ev.notes].join("; ");
      ev.score = score / 10;
    }
    return { ev, gcost: c.cost_usd };
  }

  /** Python _record_attempt: builds the attempt line + summary. */
  function recordAttempt(
    ctx: RunCtx,
    step: ResolvedStep,
    message: Message | null,
    ev: EvalResult,
    adaptations: string[],
    retries: number,
    latencyMs: number,
    batch: boolean,
    isLast: boolean,
    statusIfPass: RouteResult["status"],
  ): { att: Attempt; ln: LogLine } {
    const served = message && typeof message.model === "string" ? message.model : null;
    const tokens = usageTokens(message?.usage);
    const c = message !== null ? computeCost(config, served, step.model, tokens, batch) : { cost_usd: 0, notes: [] as string[] };
    const final = ev.passed || isLast;
    const status = final ? (ev.passed ? statusIfPass : "failed_all") : undefined;
    const ln = line(ctx, {
      step: step.step,
      requested: step.model,
      served,
      effort: sentEffort(step),
      tokens,
      cost: c.cost_usd,
      latency: latencyMs,
      passed: ev.passed,
      reason: ev.reason,
      escalated: !ev.passed && !isLast,
      final,
      batch,
      role: "attempt",
      ...(status !== undefined ? { status } : {}),
      stopReason: message?.stop_reason ?? null,
      retries,
      modelMismatch: served !== null && served !== step.model,
      adaptations: [...adaptations, ...c.notes],
    });
    const att: Attempt = {
      step: step.step,
      model: step.model,
      effort: sentEffort(step),
      passed: ev.passed,
      reason: ev.reason,
      cost_usd: round6(c.cost_usd),
      served,
      score: ev.score,
      message,
      output: ev.output,
      text: ev.text,
    };
    return { att, ln };
  }

  /** Python _result: first passing attempt wins; else best by (score, step) — ties -> later step. */
  function result(taskId: string, attempts: Attempt[], total: number, firstStep: number): BatchRouteResult {
    const winner = attempts.find((a) => a.passed);
    let status: RouteResult["status"];
    let best: Attempt;
    if (winner) {
      status = winner.step === firstStep ? "passed" : "escalated_passed";
      best = winner;
    } else {
      status = "failed_all";
      best = attempts.reduce((b, a) => (a.score > b.score || (a.score === b.score && a.step > b.step) ? a : b));
    }
    return {
      status,
      task_id: taskId,
      final_step: best.step,
      message: best.message,
      output: best.output,
      text: best.text,
      served_model: best.served,
      total_cost_usd: round6(total),
      attempts: attempts.map(({ step, model, effort, passed, reason, cost_usd }) => ({ step, model, effort, passed, reason, cost_usd })),
      custom_id: "",
    };
  }

  async function savePayload(taskId: string, pipeline: string, params: JsonObject): Promise<void> {
    await sink.savePayload(taskId, { task_id: taskId, pipeline, lang, created: isoUtc(now()), params: originalParams(params) });
  }

  /** Python _route_gen. */
  async function runRoute(ctx: RunCtx, params: JsonObject, ladder: ResolvedStep[], startIndex: number): Promise<RouteResult> {
    assertNoPrefill(params);
    http(); // TS: fail fast (missing fetch / key) before anything is persisted
    await savePayload(ctx.taskId, ctx.pipelineName, params);
    const steps = ladder.slice(startIndex);
    const attempts: Attempt[] = [];
    let total = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as ResolvedStep;
      const isLast = i === steps.length - 1;
      const { body, adaptations } = adaptRequest(config, params, step.model, step.effort);
      const tpl: FailTemplate = { ctx, step, adaptations, batch: false };
      const res = await send<Message>("POST", "/v1/messages", body, ctx, [tpl], ctx.taskId);
      const { ev, gcost } = await evaluate(ctx, step, res.data, params);
      const { att, ln } = recordAttempt(ctx, step, res.data, ev, adaptations, res.retries, res.latencyMs, false, isLast, i === 0 ? "passed" : "escalated_passed");
      await sink.writeLine(ln);
      attempts.push(att);
      total += att.cost_usd + gcost;
      if (ev.passed) break;
    }
    const { custom_id: _c, ...r } = result(ctx.taskId, attempts, total, (steps[0] as ResolvedStep).step);
    return r as RouteResult; // sync attempts always carry a message
  }

  async function route(pipelineName: string, params: MessageParams, opts: RouteOptions = {}): Promise<RouteResult> {
    const pipeline = getPipeline(config, pipelineName);
    const ladder = effectiveLadder(config, pipeline, opts.critical);
    assertNoPrefill(params);
    const ctx: RunCtx = { taskId: opts.taskId ?? newTaskId(pipelineName, now(), random), pipelineName, pipeline, humanRejected: false };
    if (opts.headers) ctx.headers = opts.headers;
    if (opts.timeoutMs) ctx.timeoutMs = opts.timeoutMs;
    return runRoute(ctx, params, ladder, 0);
  }

  async function reject(taskId: string, reason: string, opts: Omit<RouteOptions, "taskId" | "critical"> = {}): Promise<RouteResult> {
    if (!sink.loadPayload) throw new RouterConfigError("reject() needs a sink with loadPayload (file or memory sink)");
    const payload = await sink.loadPayload(taskId);
    if (!payload) throw new RouterConfigError(`no payload saved for task_id '${taskId}'`);
    const name = payload.pipeline;
    const params = payload.params;
    const pipeline = getPipeline(config, name);
    const ladder = effectiveLadder(config, pipeline);
    const opusIdx = ladder.findIndex((s) => isOpusModel(config, s.model));
    const start = opusIdx >= 0 ? opusIdx : ladder.length - 1;
    let n = 1;
    while ((await sink.loadPayload(`${taskId}-r${n}`)) !== null) n++;
    const newId = `${taskId}-r${n}`;
    const rejCtx: RunCtx = { taskId, pipelineName: name, pipeline, humanRejected: true, rejectedTaskId: taskId };
    await sink.writeLine(
      line(rejCtx, {
        step: null,
        requested: null,
        served: null,
        effort: null,
        tokens: null,
        cost: 0,
        latency: 0,
        passed: false,
        reason: `human_rejected: ${reason}`,
        escalated: false,
        final: false,
        batch: false,
        role: "rejection",
        stopReason: null,
        retries: 0,
        modelMismatch: false,
        adaptations: [],
      }),
    );
    const ctx: RunCtx = { taskId: newId, pipelineName: name, pipeline, humanRejected: true, rejectedTaskId: taskId };
    if (opts.headers) ctx.headers = opts.headers;
    if (opts.timeoutMs) ctx.timeoutMs = opts.timeoutMs;
    const r = await runRoute(ctx, params, ladder, start);
    if (sink.saveRejection) await sink.saveRejection(newId, r);
    return r;
  }

  interface BatchState {
    ctx: RunCtx;
    customId: string;
    params: JsonObject;
    attempts: Attempt[];
    cost: number;
  }

  /** Python _batch_gen. */
  async function routeBatch(pipelineName: string, items: BatchItem[], opts: Omit<RouteOptions, "taskId"> = {}): Promise<BatchRouteResult[]> {
    const pipeline = getPipeline(config, pipelineName);
    if (!pipeline.batchable) throw new RouterConfigError(`pipeline '${pipelineName}' is not batchable`);
    const ladder = effectiveLadder(config, pipeline, opts.critical);
    const pollMs = Number(config.defaults.batch_poll_seconds ?? 30) * 1000;
    const states: BatchState[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const params = it.params as JsonObject;
      assertNoPrefill(params);
      const tid = newTaskId(pipelineName, now(), random);
      const cid = it.custom_id || customIdFor(tid);
      if (!CUSTOM_ID_RE.test(cid) || seen.has(cid)) throw new RouterConfigError(`invalid or duplicate custom_id '${cid}'`);
      seen.add(cid);
      const ctx: RunCtx = { taskId: tid, pipelineName, pipeline, humanRejected: false };
      if (opts.headers) ctx.headers = opts.headers;
      if (opts.timeoutMs) ctx.timeoutMs = opts.timeoutMs;
      states.push({ ctx, customId: cid, params, attempts: [], cost: 0 });
    }
    if (states.length > 0) http();
    for (const st of states) await savePayload(st.ctx.taskId, pipelineName, st.params);

    const o = { ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) };
    let pending = states.map((_, i) => i);
    for (let si = 0; si < ladder.length; si++) {
      if (pending.length === 0) break;
      const step = ladder[si] as ResolvedStep;
      const isLast = si === ladder.length - 1;
      const requests: JsonObject[] = [];
      const adaptBy = new Map<number, string[]>();
      const tpls: FailTemplate[] = [];
      for (const i of pending) {
        const st = states[i] as BatchState;
        const { body, adaptations } = adaptRequest(config, st.params, step.model, step.effort);
        requests.push({ custom_id: st.customId, params: body });
        adaptBy.set(i, adaptations);
        tpls.push({ ctx: st.ctx, step, adaptations, batch: true });
      }
      const t0 = now();
      const created = await send<JsonObject>("POST", "/v1/messages/batches", { requests }, o, tpls, null);
      let batch = created.data;
      const batchId = String(batch.id);
      let retries = created.retries;
      while (batch.processing_status !== "ended") {
        await sleep(pollMs);
        const got = await send<JsonObject>("GET", `/v1/messages/batches/${encodeURIComponent(batchId)}`, undefined, o, tpls, null);
        batch = got.data;
        retries += got.retries;
      }
      const url = typeof batch.results_url === "string" && batch.results_url ? batch.results_url : `/v1/messages/batches/${encodeURIComponent(batchId)}/results`;
      const rr = await send<string>("GET", url, undefined, { ...o, raw: true }, tpls, null);
      retries += rr.retries;
      const latency = now() - t0;
      const byId = new Map<string, JsonObject>();
      for (const raw of rr.data.split(/\r?\n/)) {
        const t = raw.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t) as JsonObject;
          if (r && typeof r.custom_id === "string") byId.set(r.custom_id, r);
        } catch {
          /* malformed results line -> that item reads as batch:missing */
        }
      }
      const still: number[] = [];
      for (const i of pending) {
        const st = states[i] as BatchState;
        const r = byId.get(st.customId);
        const rtype: string = r === undefined ? "missing" : String(r.result?.type);
        const message: Message | null = rtype === "succeeded" ? ((r?.result?.message as Message) ?? null) : null;
        let ev: EvalResult;
        let gcost = 0;
        if (message !== null) {
          ({ ev, gcost } = await evaluate(st.ctx, step, message, st.params));
        } else {
          ev = { passed: false, reason: `batch:${rtype}`, notes: [], score: 0, output: null, text: "" };
        }
        const { att, ln } = recordAttempt(st.ctx, step, message, ev, adaptBy.get(i) ?? [], retries, latency, true, isLast, si === 0 ? "passed" : "escalated_passed");
        await sink.writeLine(ln);
        st.attempts.push(att);
        st.cost += att.cost_usd + gcost;
        if (!ev.passed) still.push(i);
      }
      pending = still;
    }
    return states.map((st) => ({ ...result(st.ctx.taskId, st.attempts, st.cost, (ladder[0] as ResolvedStep).step), custom_id: st.customId }));
  }

  return { route, routeBatch, reject };
}
