import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SpendCapExceeded, createNodeRouter, createFileSink, loadConfig, resolveRouterHome, totalSpend } from "../src/node/index.js";
import { TEST_KEY, USER_PARAMS, fakeSleep, makeConfig, mockFetch, msg, pipe } from "./helpers.js";

const S = "claude-sonnet-5-5";
const O = "claude-opus-5-5";
const ROOT = resolve(__dirname, "..", "..");
const REAL_LOGS = join(ROOT, "logs");

const REQUIRED = [
  "timestamp", "task_id", "pipeline", "step", "requested_model", "served_model", "effort", "input_tokens",
  "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "latency_ms", "validation_passed",
  "validation_reason", "escalated", "final", "batch", "role", "stop_reason", "retries", "model_mismatch",
  "human_rejected", "adaptations", "lang",
];

function listing(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listing(join(dir, e.name)).map((x) => `${e.name}/${x}`));
    else if (!dir.endsWith("verification")) out.push(e.name);
  }
  return out;
}

let home: string;
let env: Record<string, string | undefined>;
let realBefore: string[];

beforeAll(() => {
  realBefore = listing(REAL_LOGS).filter((f) => !f.startsWith("verification/"));
});
afterAll(() => {
  expect(listing(REAL_LOGS).filter((f) => !f.startsWith("verification/"))).toEqual(realBefore);
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "edgeworks-router-test-"));
  env = { EDGEWORKS_ROUTER_HOME: home, ANTHROPIC_API_KEY: TEST_KEY };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function nodeRouter(queue: Parameters<typeof mockFetch>[0], p = pipe({ validators: [{ type: "json" }, { type: "required_fields", fields: ["ok"] }] }), extraEnv: Record<string, string> = {}) {
  const { fetch, calls } = mockFetch(queue);
  const router = createNodeRouter({ config: makeConfig({ t: p }), fetch, env: { ...env, ...extraEnv }, sleep: fakeSleep().sleep });
  return { router, calls };
}

describe("node file sink", () => {
  it("payload + log files contain no API key; exact field names; UTC month file", async () => {
    const { router, calls } = nodeRouter([msg(S, '{"ok":true}', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 })]);
    const r = await router.route("t", { ...USER_PARAMS, model: "whatever" });
    expect(calls[0]!.headers["x-api-key"]).toBe(TEST_KEY); // key used on the wire only
    const pPath = join(home, "logs", "payloads", `${r.task_id}.json`);
    const raw = readFileSync(pPath, "utf8");
    expect(raw).not.toContain(TEST_KEY);
    expect(raw.toLowerCase()).not.toContain("x-api-key");
    const payload = JSON.parse(raw);
    expect(Object.keys(payload).sort()).toEqual(["created", "lang", "params", "pipeline", "task_id"]);
    expect(payload).toMatchObject({ task_id: r.task_id, pipeline: "t", lang: "ts", params: USER_PARAMS });
    expect(payload.params.model).toBeUndefined();

    const files = readdirSync(join(home, "logs")).filter((f) => f.endsWith(".jsonl"));
    expect(files).toEqual([`router-${new Date().toISOString().slice(0, 7)}.jsonl`]);
    const logRaw = readFileSync(join(home, "logs", files[0]!), "utf8");
    expect(logRaw).not.toContain(TEST_KEY);
    const line = JSON.parse(logRaw.trim());
    for (const k of REQUIRED) expect(line).toHaveProperty(k);
    expect(line.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line).toMatchObject({ cache_read_tokens: 2000, cache_write_tokens: 400, cost_usd: 0.0084, status: "passed" });
  });

  it("spend cap reads ALL log files (incl. lines written by Python) incrementally", async () => {
    mkdirSync(join(home, "logs"), { recursive: true });
    const pyFile = join(home, "logs", "router-2026-01.jsonl");
    writeFileSync(pyFile, JSON.stringify({ lang: "py", cost_usd: 0.4 }) + "\n");
    const sink = createFileSink({ home });
    expect(sink.totalSpend()).toBeCloseTo(0.4, 9);
    appendFileSync(pyFile, JSON.stringify({ lang: "py", cost_usd: 0.35 }) + "\n" + '{"partial":');
    expect(sink.totalSpend()).toBeCloseTo(0.75, 9);
    expect(totalSpend({ home })).toBeCloseTo(0.75, 9);

    const { router, calls } = nodeRouter([msg(S, '{"ok":1}')], undefined, { EDGEWORKS_ROUTER_SPEND_CAP_USD: "0.75" });
    await expect(router.route("t", USER_PARAMS)).rejects.toBeInstanceOf(SpendCapExceeded);
    expect(calls).toHaveLength(0);

    const ok = nodeRouter([msg(S, '{"ok":1}')], undefined, { EDGEWORKS_ROUTER_SPEND_CAP_USD: "3" });
    await ok.router.route("t", USER_PARAMS);
    expect(ok.calls).toHaveLength(1);
  });

  it("reject via file sink writes -r1 payload, rejection line and logs/rejections/<id>.json", async () => {
    const { router } = nodeRouter([msg(S, '{"ok":true}'), msg(O, '{"ok":"opus"}')]);
    const orig = await router.route("t", USER_PARAMS);
    const r = await router.reject(orig.task_id, "not good");
    expect(r.task_id).toBe(`${orig.task_id}-r1`);
    expect(existsSync(join(home, "logs", "payloads", `${r.task_id}.json`))).toBe(true);
    expect(existsSync(join(home, "logs", "rejections", `${r.task_id}.json`))).toBe(true);
    const lines = readFileSync(join(home, "logs", `router-${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.role)).toEqual(["attempt", "rejection", "attempt"]);
    expect(lines[2]).toMatchObject({ task_id: r.task_id, rejected_task_id: orig.task_id, human_rejected: true, requested_model: O, step: 2 });
  });

  it("command validator runs a process with {file} and fails on non-zero exit", async () => {
    const script = "const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(o.ok===true?0:3)";
    const p = pipe({ validators: [{ type: "json" }, { type: "command", cmd: [process.execPath, "-e", script, "{file}"] }] });
    const { router } = nodeRouter([msg(S, '{"ok":false}'), msg(O, '{"ok":true}')], p);
    const r = await router.route("t", USER_PARAMS);
    expect(r.status).toBe("escalated_passed");
    expect(r.attempts[0]!.reason).toBe("command_exit:3");
  });

  it("loadConfig reads the real routing.json (read-only) and honors EDGEWORKS_ROUTING_JSON", () => {
    const cfg = loadConfig(undefined, {});
    expect(cfg.models.sonnet).toBe(S);
    expect(cfg.pipelines["smoke-test"]).toBeTruthy();
    expect(cfg.pipelines["smoke-force-escalation"]!.validators).toEqual([{ type: "custom", name: "fail_on_step_1" }]);
    expect(resolveRouterHome({})).toBe(ROOT);

    const alt = join(home, "alt.json");
    writeFileSync(alt, JSON.stringify(makeConfig({ only: pipe() })));
    const cfg2 = loadConfig(undefined, { EDGEWORKS_ROUTING_JSON: alt });
    expect(Object.keys(cfg2.pipelines)).toEqual(["only"]);
  });

  it("missing API key fails fast without writing anything", async () => {
    const { fetch, calls } = mockFetch([]);
    const router = createNodeRouter({ config: makeConfig({ t: pipe() }), fetch, env: { EDGEWORKS_ROUTER_HOME: home } });
    await expect(router.route("t", USER_PARAMS)).rejects.toThrow(/API key/);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(home, "logs"))).toBe(false);
  });
});
