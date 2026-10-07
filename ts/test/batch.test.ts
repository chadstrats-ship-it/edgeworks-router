import { describe, expect, it } from "vitest";
import { RouterConfigError, createMemorySink, createRouter } from "../src/core/index.js";
import { TEST_KEY, fakeSleep, makeConfig, mockBatchFetch, msg, pipe } from "./helpers.js";

const S = "claude-sonnet-5-5";
const O = "claude-opus-5-5";

describe("batch mode", () => {
  it("resubmits ONLY failures, on Opus, and returns results in input order", async () => {
    const config = makeConfig({ b: pipe({ batchable: true, validators: [{ type: "json" }, { type: "required_fields", fields: ["ok"] }] }) });
    // round 0 (sonnet): item0 ok, item1 bad json, item2 errored, item3 refusal; round 1 (opus): all ok
    const byContent = (params: any) => String(params.messages[0].content);
    const m = mockBatchFetch(({ round, params }) => {
      const c = byContent(params);
      if (round === 0) {
        if (c === "i0") return { type: "succeeded", message: msg(S, '{"ok":0}', { input_tokens: 1000, output_tokens: 1000 }) };
        if (c === "i1") return { type: "succeeded", message: msg(S, "not json", { input_tokens: 1000, output_tokens: 1000 }) };
        if (c === "i2") return { type: "errored", error: { type: "error", error: { type: "api_error" } } };
        return { type: "succeeded", message: msg(S, "no", {}, "refusal") };
      }
      return { type: "succeeded", message: msg(O, `{"ok":"${c}"}`, { input_tokens: 1000, output_tokens: 1000 }) };
    });
    const sink = createMemorySink();
    const fs = fakeSleep();
    const router = createRouter({ config, fetch: m.fetch, sink, apiKey: TEST_KEY, sleep: fs.sleep, random: () => 0.5 });
    const items = ["i0", "i1", "i2", "i3"].map((c, i) => ({ custom_id: `item-${i}`, params: { max_tokens: 50, messages: [{ role: "user", content: c }] } }));
    const results = await router.routeBatch("b", items);

    expect(m.batches).toHaveLength(2);
    expect(m.batches[0]!.requests).toHaveLength(4);
    expect(m.batches[0]!.requests.every((r) => r.params.model === S && r.params.output_config.effort === "high")).toBe(true);
    // only the 3 failures resubmitted, at step 2 on opus
    expect(m.batches[1]!.requests.map((r) => r.params.messages[0].content).sort()).toEqual(["i1", "i2", "i3"]);
    expect(m.batches[1]!.requests.every((r) => r.params.model === O && r.params.output_config.effort === "medium")).toBe(true);
    for (const r of m.batches[0]!.requests) expect(r.custom_id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // polling uses batch_poll_seconds
    expect(fs.sleeps).toEqual([30000, 30000, 30000, 30000]); // 2 polls per batch x 2 batches

    expect(results.map((r) => [r.custom_id, r.status, r.final_step])).toEqual([
      ["item-0", "passed", 1],
      ["item-1", "escalated_passed", 2],
      ["item-2", "escalated_passed", 2],
      ["item-3", "escalated_passed", 2],
    ]);
    expect(results[1]!.output).toEqual({ ok: "i1" });

    const lines = sink.lines.filter((l) => l.role === "attempt");
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => l.batch === true)).toBe(true);
    const l0 = lines.find((l) => l.task_id === results[0]!.task_id)!;
    expect(l0.cost_usd).toBe(0.006); // (1000*2 + 1000*10)/1e6 * 0.5
    const errored = lines.find((l) => l.task_id === results[2]!.task_id && l.step === 1)!;
    expect(errored).toMatchObject({ validation_reason: "batch:errored", escalated: true, final: false, cost_usd: 0 });
    const refused = lines.find((l) => l.task_id === results[3]!.task_id && l.step === 1)!;
    expect(refused.validation_reason).toBe("stop_reason:refusal");
    const opusLine = lines.find((l) => l.task_id === results[1]!.task_id && l.step === 2)!;
    expect(opusLine).toMatchObject({ cost_usd: 0.012, final: true, status: "escalated_passed", batch: true });
    // payload per item
    expect(sink.payloads.size).toBe(4);
  });

  it("items failing every step -> failed_all with best attempt", async () => {
    const config = makeConfig({ b: pipe({ batchable: true, validators: [{ type: "json" }, { type: "required_fields", fields: ["ok"] }] }) });
    const m = mockBatchFetch(({ round }) =>
      round === 0
        ? { type: "succeeded", message: msg(S, '{"nope":1}') }
        : { type: "expired" },
    );
    const sink = createMemorySink();
    const router = createRouter({ config, fetch: m.fetch, sink, apiKey: TEST_KEY, sleep: fakeSleep().sleep });
    const [r] = await router.routeBatch("b", [{ params: { max_tokens: 5, messages: [{ role: "user", content: "q" }] } }]);
    expect(r!.status).toBe("failed_all");
    expect(r!.final_step).toBe(1);
    expect(r!.text).toBe('{"nope":1}');
    const last = sink.lines.filter((l) => l.role === "attempt").at(-1)!;
    expect(last).toMatchObject({ step: 2, validation_reason: "batch:expired", final: true, status: "failed_all" });
  });

  it("non-batchable pipeline is rejected", async () => {
    const config = makeConfig({ nb: pipe({ batchable: false }) });
    const router = createRouter({ config, fetch: mockBatchFetch(() => ({ type: "expired" })).fetch, apiKey: TEST_KEY });
    await expect(router.routeBatch("nb", [{ params: { max_tokens: 5, messages: [{ role: "user", content: "q" }] } }])).rejects.toBeInstanceOf(RouterConfigError);
  });
});
