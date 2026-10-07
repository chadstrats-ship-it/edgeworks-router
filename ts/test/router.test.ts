import { describe, expect, it } from "vitest";
import {
  PrefillNotSupported,
  RouterInfraError,
  RouterRequestError,
  SpendCapExceeded,
  computeCost,
  createMemorySink,
  createRouter,
} from "../src/core/index.js";
import type { CreateRouterOptions, LogLine, Message, PipelineConfig } from "../src/core/types.js";
import { TEST_KEY, USER_PARAMS, fakeSleep, makeConfig, mockFetch, msg, pipe } from "./helpers.js";

const S = "claude-sonnet-5-5";
const O = "claude-opus-5-5";
const H = "claude-haiku-4-5-20251001";
const JSON_OK: PipelineConfig["validators"] = [{ type: "json" }, { type: "required_fields", fields: ["ok"] }];

function setup(p: Partial<PipelineConfig>, queue: Parameters<typeof mockFetch>[0], extra: Partial<CreateRouterOptions> = {}) {
  const config = makeConfig({ t: pipe(p) });
  const { fetch, calls } = mockFetch(queue);
  const sink = createMemorySink();
  const fs = fakeSleep();
  const router = createRouter({ config, fetch, sink, apiKey: TEST_KEY, sleep: fs.sleep, random: () => 0.5, ...extra });
  const attempts = () => sink.lines.filter((l) => l.role === "attempt");
  return { router, calls, sink, sleeps: fs.sleeps, attempts, config };
}

describe("routing loop", () => {
  it("passes at step 1", async () => {
    const t = setup({ validators: JSON_OK }, [msg(S, '{"ok":true}')]);
    const r = await t.router.route("t", { ...USER_PARAMS, model: "ignored-model" });
    expect(r.status).toBe("passed");
    expect(r.final_step).toBe(1);
    expect(r.output).toEqual({ ok: true });
    expect(r.message.content.find((b) => b.type === "text")?.text).toBe('{"ok":true}');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(t.calls[0]!.body.model).toBe(S);
    expect(t.calls[0]!.body.output_config).toEqual({ effort: "high" });
    expect(t.calls[0]!.headers["x-api-key"]).toBe(TEST_KEY);
    expect(t.calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(Object.keys(t.calls[0]!.headers).some((h) => h.startsWith("anthropic-beta"))).toBe(false);
    const [l] = t.attempts();
    expect(l).toMatchObject({ step: 1, final: true, escalated: false, validation_passed: true, validation_reason: null, status: "passed", lang: "ts", batch: false });
    expect(r.task_id).toMatch(/^t-\d{14}-[0-9a-f]{8}$/);
  });

  it("schema fail at step 1 then passes on Opus", async () => {
    const schema = { type: "object", properties: { n: { type: "integer", minimum: 1 } }, required: ["n"] };
    const t = setup({ validators: [{ type: "json" }, { type: "json_schema", schema }] }, [msg(S, '{"n":0}'), msg(O, '{"n":3}')]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.status).toBe("escalated_passed");
    expect(r.final_step).toBe(2);
    expect(t.calls[1]!.body.model).toBe(O);
    expect(t.calls[1]!.body.output_config).toEqual({ effort: "medium" });
    const [a, b] = t.attempts();
    expect(a).toMatchObject({ step: 1, validation_passed: false, validation_reason: "schema:/n:minimum", escalated: true, final: false });
    expect(a).not.toHaveProperty("status");
    expect(b).toMatchObject({ step: 2, validation_passed: true, final: true, status: "escalated_passed" });
  });

  it("max_tokens escalates", async () => {
    const t = setup({}, [msg(S, "partial", {}, "max_tokens"), msg(O, "done")]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.status).toBe("escalated_passed");
    expect(t.attempts()[0]!.validation_reason).toBe("stop_reason:max_tokens");
  });

  it("refusal escalates", async () => {
    const t = setup({}, [msg(S, "I can't help with that.", {}, "refusal"), msg(O, "ok")]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.status).toBe("escalated_passed");
    expect(t.attempts()[0]).toMatchObject({ validation_reason: "stop_reason:refusal", escalated: true, stop_reason: "refusal" });
    expect(t.calls[1]!.body.model).toBe(O);
  });

  it("529 retries the SAME model and does not escalate", async () => {
    const t = setup({}, [{ status: 529, body: { type: "error", error: { type: "overloaded_error" } } }, msg(S, "fine")]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.status).toBe("passed");
    expect(r.final_step).toBe(1);
    expect(t.calls.map((c) => c.body.model)).toEqual([S, S]);
    expect(t.sleeps).toEqual([750]); // min(30000, 1000*2^0) * (0.5 + 0.5*0.5)
    expect(t.attempts()).toHaveLength(1);
    expect(t.attempts()[0]!.retries).toBe(1);
  });

  it("429 retry-after honored when larger than backoff", async () => {
    const t = setup({}, [
      { status: 429, headers: { "retry-after": "7" } },
      { status: 429, headers: { "retry-after": "0" } },
      msg(S, "fine"),
    ]);
    await t.router.route("t", USER_PARAMS);
    expect(t.sleeps).toEqual([7000, 1500]); // retry-after 7s wins; then jitter 2000*0.75 beats retry-after 0
    expect(t.calls.map((c) => c.body.model)).toEqual([S, S, S]);
  });

  it("retries exhausted -> RouterInfraError, no escalation", async () => {
    const q = Array.from({ length: 5 }, () => ({ status: 529 }));
    const t = setup({}, q);
    await expect(t.router.route("t", USER_PARAMS)).rejects.toBeInstanceOf(RouterInfraError);
    expect(t.calls).toHaveLength(5);
    expect(t.calls.every((c) => c.body.model === S)).toBe(true);
    expect(t.sleeps).toHaveLength(4);
    const lines = t.attempts();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ validation_reason: "infra:529", final: true, input_tokens: 0, output_tokens: 0, cost_usd: 0, retries: 4, served_model: null });
  });

  it("400 -> RouterRequestError (no retry, no escalation)", async () => {
    const t = setup({}, [{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } }]);
    const err = await t.router.route("t", USER_PARAMS).catch((e) => e);
    expect(err).toBeInstanceOf(RouterRequestError);
    expect(err.status).toBe(400);
    expect(t.calls).toHaveLength(1);
    expect(t.sleeps).toHaveLength(0);
    expect(t.attempts()[0]).toMatchObject({ validation_reason: "http_400", final: true });
  });

  it("all fail -> failed_all returning the best attempt", async () => {
    const t = setup({ validators: JSON_OK }, [msg(S, '{"nope":1}'), msg(O, "garbage")]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.status).toBe("failed_all");
    expect(r.final_step).toBe(1);
    expect(r.text).toBe('{"nope":1}');
    expect(r.message.model).toBe(S);
    expect(r.attempts.map((a) => [a.step, a.passed, a.reason])).toEqual([
      [1, false, "required_fields:ok"],
      [2, false, "json_parse"],
    ]);
    const last = t.attempts()[1]!;
    expect(last).toMatchObject({ final: true, escalated: false, status: "failed_all" });
  });

  it("served_model mismatch is logged (and unknown served model falls back to requested pricing)", async () => {
    const t = setup({}, [msg("claude-sonnet-5", "hi", { input_tokens: 1_000_000, output_tokens: 0 })]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.served_model).toBe("claude-sonnet-5");
    expect(t.attempts()[0]).toMatchObject({ requested_model: S, served_model: "claude-sonnet-5", model_mismatch: true, cost_usd: 2.0 });

    const u = setup({}, [msg("claude-mystery-9", "hi", { input_tokens: 1_000_000, output_tokens: 0 })]);
    await u.router.route("t", USER_PARAMS);
    const l = u.attempts()[0]!;
    expect(l.model_mismatch).toBe(true);
    expect(l.adaptations).toContain("pricing_fallback");
    expect(l.cost_usd).toBe(2.0); // priced at requested sonnet
  });

  it("cost math to the cent incl cache tokens and batch discount", () => {
    const cfg = makeConfig();
    const c1 = computeCost(cfg, S, S, { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 2000, cache_write_tokens: 400 }, false);
    expect(c1.cost_usd).toBe(0.0084);
    const c2 = computeCost(cfg, O, O, { input_tokens: 123, output_tokens: 456, cache_write_tokens: 789, cache_read_tokens: 1011 }, true);
    expect(c2.cost_usd).toBe(0.00688); // (492 + 9120 + 3945 + 202.2)/1e6 * 0.5 = 0.0068796 -> 6dp
    const c3 = computeCost(cfg, H, H, { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_write_tokens: 1_000_000, cache_read_tokens: 1_000_000 }, true);
    expect(c3.cost_usd).toBe(3.675); // (1 + 5 + 1.25 + 0.1)/2
    expect(Math.round(c3.cost_usd * 100) / 100).toBe(3.68);
    const c4 = computeCost(cfg, O, O, { input_tokens: 2_000_000, output_tokens: 300_000, cache_write_tokens: 100_000, cache_read_tokens: 5_000_000 }, false);
    expect(c4.cost_usd).toBe(15.5); // 8 + 6 + 0.5 + 1.0
  });

  it("critical enables step 3; non-critical stops at step 2", async () => {
    const bad = () => [msg(S, "x", {}, "max_tokens"), msg(O, "x", {}, "max_tokens"), msg(O, "x", {}, "max_tokens")];
    const crit = setup({ critical: true }, bad());
    const r1 = await crit.router.route("t", USER_PARAMS);
    expect(r1.status).toBe("failed_all");
    expect(crit.calls.map((c) => [c.body.model, c.body.output_config?.effort])).toEqual([
      [S, "high"],
      [O, "medium"],
      [O, "xhigh"],
    ]);
    const non = setup({ critical: false }, bad());
    await non.router.route("t", USER_PARAMS);
    expect(non.calls).toHaveLength(2);
    expect(non.attempts()[1]).toMatchObject({ step: 2, final: true, status: "failed_all" });
  });

  it("forced tool_choice -> auto + strict, unsupported keywords stripped, temperature removed (sent body)", async () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", maxLength: 5, minLength: 1, format: "regex", description: "short" },
        n: { type: "number", minimum: 0, maximum: 10, multipleOf: 2 },
        tags: { type: "array", items: { type: "object", properties: { k: { type: "string", pattern: "(\\w)\\1" } } }, minItems: 3, maxItems: 9, uniqueItems: true },
        d: { type: "string", format: "date" },
        one: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["a"],
    };
    const params = {
      max_tokens: 100,
      messages: [{ role: "user", content: "x" }],
      tools: [
        { name: "t", input_schema: schema },
        { name: "other", input_schema: { type: "object", properties: { z: { type: "string", maxLength: 3 } } } },
      ],
      tool_choice: { type: "tool", name: "t" },
      temperature: 0.2,
      top_k: 5,
      top_p: 0.5,
      thinking: { type: "disabled" },
    };
    const snapshot = JSON.parse(JSON.stringify(params));
    const tu = (a: string) => msg(S, null, {}, "tool_use", [{ type: "tool_use", id: "tu1", name: "t", input: { a } }]);
    const t = setup({ validators: [{ type: "tool_use", name: "t" }, { type: "json_schema", schema }] }, [tu("waytoolong"), { ...tu("ok"), model: O }]);
    const r = await t.router.route("t", params);
    const sent = t.calls[0]!.body;
    expect(sent.tool_choice).toEqual({ type: "auto" });
    expect(sent.tools[0].strict).toBe(true);
    expect(sent.tools[1].strict).toBeUndefined();
    expect(sent.tools[1].input_schema.properties.z.maxLength).toBe(3); // untargeted tool untouched
    const s = sent.tools[0].input_schema;
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.tags.items.additionalProperties).toBe(false);
    expect(s.properties.a).toEqual({ type: "string", description: "short" }); // stripped, description untouched (Python parity)
    expect(s.properties.n).toEqual({ type: "number" });
    expect(s.properties.tags.minItems).toBeUndefined();
    expect(s.properties.tags.maxItems).toBeUndefined();
    expect(s.properties.tags.uniqueItems).toBeUndefined();
    expect(s.properties.tags.items.properties.k.pattern).toBeUndefined();
    expect(s.properties.d.format).toBe("date");
    expect(s.properties.one.minItems).toBe(1);
    expect("temperature" in sent).toBe(false);
    expect("top_k" in sent).toBe(false);
    expect("top_p" in sent).toBe(false);
    expect(sent.thinking).toEqual({ type: "between_tools" });
    expect(sent.output_config).toEqual({ effort: "high" });
    expect(params).toEqual(snapshot); // caller's params never mutated
    const l = t.attempts()[0]!;
    expect(l.adaptations).toEqual(
      expect.arrayContaining([
        "forced_tool_use->auto_strict",
        "temperature_removed",
        "top_k_removed",
        "top_p_removed",
        "thinking_disabled->between_tools",
      ]),
    );
    expect(l.adaptations.filter((a) => a.startsWith("strict_strip:"))).toEqual([
      "strict_strip:t/properties/a/minLength",
      "strict_strip:t/properties/a/maxLength",
      "strict_strip:t/properties/a/format",
      "strict_strip:t/properties/n/minimum",
      "strict_strip:t/properties/n/maximum",
      "strict_strip:t/properties/n/multipleOf",
      "strict_strip:t/properties/tags/maxItems",
      "strict_strip:t/properties/tags/uniqueItems",
      "strict_strip:t/properties/tags/minItems",
      "strict_strip:t/properties/tags/items/properties/k/pattern",
    ]);
    // local validator still enforces the ORIGINAL schema (maxLength 5)
    expect(l.validation_reason).toBe("schema:/a:maxLength");
    expect(r.status).toBe("escalated_passed");
    expect(r.output).toEqual({ a: "ok" });
  });

  it("thinking enabled -> adaptive; tool_choice any marks all tools strict", async () => {
    const params = {
      ...USER_PARAMS,
      tools: [
        { name: "a", input_schema: { type: "object", properties: {} } },
        { name: "b", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "any" },
      thinking: { type: "enabled", budget_tokens: 2000 },
      temperature: 1,
    };
    const t = setup({}, [msg(S, "hi")]);
    await t.router.route("t", params);
    const sent = t.calls[0]!.body;
    expect(sent.tools.map((x: any) => x.strict)).toEqual([true, true]);
    expect(sent.thinking).toEqual({ type: "adaptive" });
    expect(sent.temperature).toBe(1); // temperature == 1 is allowed
  });

  it("grader runs only for free-text pipelines", async () => {
    const grader = (score: number) => msg(H, `{"score": ${score}, "reason": "r"}`, { input_tokens: 1000, output_tokens: 100 });
    // free text: grader called on Haiku, no effort field
    const a = setup({ validators: [], grader: { enabled: true, threshold: 7, rubric: "be good" } }, [msg(S, "an essay", { input_tokens: 10, output_tokens: 10 }), grader(8)]);
    const ra = await a.router.route("t", { max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "write an essay" }] }] });
    expect(ra.status).toBe("passed");
    expect(a.calls).toHaveLength(2);
    const gb = a.calls[1]!.body;
    expect(gb.model).toBe(H);
    expect(gb.output_config).toBeUndefined();
    expect(gb.messages[0].content).toContain("be good");
    expect(gb.messages[0].content).toContain("write an essay");
    expect(gb.messages[0].content).toContain("an essay");
    const gl = a.sink.lines.find((l) => l.role === "grader")!;
    expect(gl).toMatchObject({ requested_model: H, effort: null, cost_usd: 0.0015, validation_passed: true, validation_reason: "grader:8", final: false, batch: false });
    // grader line is written BEFORE its attempt line
    expect(a.sink.lines.map((l) => l.role)).toEqual(["grader", "attempt"]);
    expect(ra.total_cost_usd).toBe(0.00162); // 0.00012 attempt + 0.0015 grader

    // deterministic validators present -> NO grader
    const b = setup({ validators: [{ type: "json" }], grader: { enabled: true, threshold: 7, rubric: "x" } }, [msg(S, "{}")]);
    await b.router.route("t", USER_PARAMS);
    expect(b.calls).toHaveLength(1);
    expect(b.sink.lines.some((l) => l.role === "grader")).toBe(false);

    // unavailable custom validator only -> still free-text -> grader runs; low score escalates
    const c = setup({ validators: [{ type: "custom", name: "py_only" }], grader: { enabled: true, threshold: 7, rubric: "x" } }, [msg(S, "meh"), grader(3), msg(O, "better"), grader(9)]);
    const rc = await c.router.route("t", USER_PARAMS);
    expect(rc.status).toBe("escalated_passed");
    expect(c.attempts()[0]!.validation_reason).toBe("grader:3; custom:py_only:unavailable");
    expect(c.attempts()[1]!.validation_reason).toBe("custom:py_only:unavailable");
  });

  it("grader parse error -> attempt passes with grader_error (never silent)", async () => {
    const t = setup({ grader: { enabled: true, threshold: 7, rubric: "x" } }, [msg(S, "text"), msg(H, "not json at all")]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.status).toBe("passed");
    expect(t.attempts()[0]!.validation_reason).toBe("grader_error:parse");
    expect(t.sink.lines.find((l) => l.role === "grader")).toMatchObject({ validation_reason: "grader_parse", validation_passed: false });
  });

  it("grader infra failure -> attempt passes with grader_error:infra_<code>, no grader line", async () => {
    const t = setup({ grader: { enabled: true, threshold: 7, rubric: "x" } }, [msg(S, "text"), { status: 400 }]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.status).toBe("passed");
    expect(t.attempts()[0]!.validation_reason).toBe("grader_error:infra_400");
    expect(t.sink.lines.some((l) => l.role === "grader")).toBe(false);
  });

  it("spend cap: refuses before any call when total >= cap, and mid-ladder", async () => {
    const t = setup({}, [msg(S, "x")], { spendCapUsd: 3 });
    t.sink.lines.push({ cost_usd: 3.0 } as LogLine);
    await expect(t.router.route("t", USER_PARAMS)).rejects.toBeInstanceOf(SpendCapExceeded);
    expect(t.calls).toHaveLength(0);

    const u = setup({ validators: JSON_OK }, [msg(S, "nope", { input_tokens: 100, output_tokens: 50 }), msg(O, '{"ok":1}')], { spendCapUsd: 0.0005 });
    await expect(u.router.route("t", USER_PARAMS)).rejects.toBeInstanceOf(SpendCapExceeded);
    expect(u.calls).toHaveLength(1); // step 1 cost 0.0007 >= cap -> step 2 never sent
  });

  it("assistant prefill -> PrefillNotSupported before anything is sent or saved", async () => {
    const t = setup({}, []);
    const p = { max_tokens: 10, messages: [{ role: "user", content: "x" }, { role: "assistant", content: "{" }] };
    await expect(t.router.route("t", p)).rejects.toBeInstanceOf(PrefillNotSupported);
    expect(t.calls).toHaveLength(0);
    expect(t.sink.payloads.size).toBe(0);
  });

  it("built-in fail_on_step_1 forces escalation; pinned Haiku sends no effort", async () => {
    const t = setup({ validators: [{ type: "custom", name: "fail_on_step_1" }] }, [msg(S, "a"), msg(O, "b")]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.status).toBe("escalated_passed");
    expect(t.attempts()[0]!.validation_reason).toBe("custom:fail_on_step_1:step_1");

    const h = setup({ pinned_model: "grader" }, [msg(H, "a"), msg(H, "b")]);
    const rh = await h.router.route("t", { ...USER_PARAMS, output_config: { effort: "low" } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body.model).toBe(H);
    expect(h.calls[0]!.body.output_config).toBeUndefined();
    expect(h.attempts()[0]!.adaptations).toContain("effort_removed_haiku");
    expect(rh.status).toBe("passed");
  });

  it("call-site beta headers are passed through; router adds none", async () => {
    const t = setup({}, [msg(S, "x")]);
    await t.router.route("t", USER_PARAMS, { headers: { "anthropic-beta": "some-beta-2026", "x-api-key": "evil-override" } });
    expect(t.calls[0]!.headers["anthropic-beta"]).toBe("some-beta-2026");
    expect(t.calls[0]!.headers["x-api-key"]).toBe(TEST_KEY);
  });
});

describe("reject", () => {
  it("re-runs from the first Opus step with human_rejected + rejected_task_id", async () => {
    const t = setup({ validators: JSON_OK }, [msg(S, '{"ok":true}'), msg(O, '{"ok":"better"}'), msg(O, '{"ok":"again"}')]);
    const orig = await t.router.route("t", USER_PARAMS);
    const r = await t.router.reject(orig.task_id, "wrong tone");
    expect(r.task_id).toBe(`${orig.task_id}-r1`);
    expect(r.status).toBe("passed");
    expect(r.final_step).toBe(2);
    expect(t.calls[1]!.body.model).toBe(O);
    expect(t.calls[1]!.body.output_config).toEqual({ effort: "medium" });
    const rej = t.sink.lines.find((l) => l.role === "rejection")!;
    expect(rej).toMatchObject({ task_id: orig.task_id, step: null, requested_model: null, rejected_task_id: orig.task_id, human_rejected: true, validation_reason: "human_rejected: wrong tone", input_tokens: 0, cost_usd: 0 });
    const rerun = t.sink.lines.filter((l) => l.task_id === r.task_id);
    expect(rerun).toHaveLength(1);
    expect(rerun[0]).toMatchObject({ step: 2, human_rejected: true, rejected_task_id: orig.task_id, final: true });
    expect(t.sink.payloads.get(r.task_id)!.params).toEqual(USER_PARAMS);
    expect(t.sink.rejections.get(r.task_id)).toBeTruthy();
    const r2 = await t.router.reject(orig.task_id, "still wrong");
    expect(r2.task_id).toBe(`${orig.task_id}-r2`);
  });
});

describe("message passthrough", () => {
  it("returns the raw Messages API JSON so content.find(type) works", async () => {
    const m: Message = msg(S, null, {}, "tool_use", [
      { type: "thinking", thinking: "" },
      { type: "tool_use", id: "tu", name: "save", input: { x: 1 } },
    ]);
    const t = setup({ validators: [{ type: "tool_use", name: "save" }] }, [m]);
    const r = await t.router.route("t", USER_PARAMS);
    expect(r.message).toEqual(m);
    expect(r.message.content.find((b) => b.type === "tool_use")?.input).toEqual({ x: 1 });
    expect(r.output).toEqual({ x: 1 });
  });
});
