// Cross-language parity: for every case in shared/fixtures/parity.json + test/fixtures/xlang-cases.json, the
// log lines / payloads / results written by TS must deep-equal those written by the REAL Python router
// (driven by test/py/xlang_dump.py with the Python suite's FakeClient + MemorySink), after normalizing only
// timestamp, latency_ms, lang, created and task ids (mapped to T0, T1, ... by first appearance).
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemorySink, createRouter } from "../src/core/index.js";
import type { Message, RoutingConfig } from "../src/core/types.js";
import { TEST_KEY, fakeSleep, mockBatchFetch, mockFetch, type MockResp } from "./helpers.js";

const ROOT = resolve(__dirname, "..", "..");
// Python used for the cross-language check: EDGEWORKS_XLANG_PYTHON, else the repo venv, else `python`/`python3` on PATH.
const VENV_PY = join(ROOT, "python", ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
const PY = process.env.EDGEWORKS_XLANG_PYTHON || (existsSync(VENV_PY) ? VENV_PY : process.platform === "win32" ? "python" : "python3");
const ROUTING = join(ROOT, "routing.json");
const DEFAULT_REQUEST = { max_tokens: 100, messages: [{ role: "user", content: "x" }] };
const PIPE_DEFAULTS = {
  description: "xlang",
  ladder: null,
  validators: [],
  grader: { enabled: false, threshold: 7, rubric: "" },
  max_attempts: 3,
  batchable: false,
  critical: false,
  pinned_model: null,
};

type Resp = Message | { __status: number; headers?: Record<string, string> };
interface XCase {
  name: string;
  pipeline?: Record<string, unknown>;
  request?: Record<string, unknown>;
  responses?: Resp[];
  reject?: string;
  batch?: { items: Array<{ content: string; rounds: Array<Message | string> }> };
}

function loadCases(): XCase[] {
  const parity = JSON.parse(readFileSync(join(ROOT, "shared", "fixtures", "parity.json"), "utf8")).cases as any[];
  const fromParity: XCase[] = parity.map((c) =>
    c.batch
      ? { name: `parity:${c.name}`, pipeline: { validators: c.validators, batchable: true }, batch: { items: [{ content: "x", rounds: c.responses }] } }
      : { name: `parity:${c.name}`, pipeline: { validators: c.validators }, request: c.request, responses: c.responses },
  );
  const extra = JSON.parse(readFileSync(join(__dirname, "fixtures", "xlang-cases.json"), "utf8")).cases as XCase[];
  return [...fromParity, ...extra];
}

interface Dump {
  lines: any[];
  payloads: Record<string, any>;
  results: any[];
  error: string | null;
}

async function runTs(c: XCase, base: RoutingConfig): Promise<Dump> {
  const config: RoutingConfig = { ...JSON.parse(JSON.stringify(base)), pipelines: { p: { ...PIPE_DEFAULTS, ...(c.pipeline ?? {}) } } };
  const sink = createMemorySink();
  const common = { config, sink, apiKey: TEST_KEY, sleep: fakeSleep().sleep, random: () => 0.5 };
  const results: any[] = [];
  let error: string | null = null;
  try {
    if (c.batch) {
      const byContent = new Map(c.batch.items.map((it) => [it.content, it.rounds]));
      const m = mockBatchFetch(({ round, params }) => {
        const r = byContent.get(String(params.messages[0].content))![round]!;
        return typeof r === "string" ? ({ type: r } as any) : { type: "succeeded", message: r };
      });
      const router = createRouter({ ...common, fetch: m.fetch });
      const items = c.batch.items.map((it) => ({ params: { max_tokens: 100, messages: [{ role: "user", content: it.content }] } }));
      for (const r of await router.routeBatch("p", items)) results.push(r);
    } else {
      const queue = (c.responses ?? []).map((r) =>
        "__status" in r ? ({ status: r.__status, ...(r.headers ? { headers: r.headers } : {}) } as MockResp) : r,
      );
      const router = createRouter({ ...common, fetch: mockFetch(queue).fetch });
      const res = await router.route("p", (c.request ?? DEFAULT_REQUEST) as any);
      results.push(res);
      if (c.reject) results.push(await router.reject(res.task_id, c.reject));
    }
  } catch (e) {
    error = (e as Error).name;
  }
  const payloads: Record<string, any> = {};
  for (const [k, v] of sink.payloads) payloads[k] = v;
  return { lines: sink.lines, payloads, results: JSON.parse(JSON.stringify(results)), error };
}

function normalize(d: Dump) {
  const ids = new Map<string, string>();
  const nid = (id: string) => {
    if (!ids.has(id)) ids.set(id, `T${ids.size}`);
    return ids.get(id)!;
  };
  const lines = d.lines.map((l) => {
    const { timestamp: _t, latency_ms: _l, lang: _g, ...rest } = l;
    rest.task_id = nid(rest.task_id);
    if (rest.rejected_task_id) rest.rejected_task_id = nid(rest.rejected_task_id);
    return rest;
  });
  const results = d.results.map((r) => {
    const { message: _m, custom_id: _c, ...rest } = r;
    rest.task_id = nid(rest.task_id);
    return rest;
  });
  const payloads: Record<string, any> = {};
  for (const [id, p] of Object.entries(d.payloads)) payloads[nid(id)] = { pipeline: p.pipeline, params: p.params, task_id: nid(p.task_id) };
  return { lines, results, payloads, error: d.error };
}

function canRun(py: string): boolean {
  const r = spawnSync(py, ["-c", "import pytest"], { encoding: "utf8" });
  return r.status === 0;
}

const havePython = canRun(PY) && existsSync(join(ROOT, "python", "edgeworks_router", "router.py"));

describe.skipIf(!havePython)("cross-language parity vs the real Python router", () => {
  const cases = loadCases();
  let py: Record<string, Dump> = {};
  const base = JSON.parse(readFileSync(ROUTING, "utf8")) as RoutingConfig;

  it("python driver runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "edgeworks-xlang-"));
    try {
      const casesFile = join(dir, "cases.json");
      writeFileSync(casesFile, JSON.stringify(cases));
      const env = { ...process.env, PYTHONIOENCODING: "utf-8", EDGEWORKS_ROUTER_HOME: dir };
      delete (env as Record<string, string | undefined>).EDGEWORKS_ROUTER_SPEND_CAP_USD;
      delete (env as Record<string, string | undefined>).EDGEWORKS_ROUTING_JSON;
      const out = execFileSync(PY, [join(__dirname, "py", "xlang_dump.py"), casesFile, ROUTING, join(ROOT, "python")], {
        env,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      py = JSON.parse(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(Object.keys(py).sort()).toEqual(cases.map((c) => c.name).sort());
  }, 120_000);

  for (const c of cases) {
    it(`TS == Python: ${c.name}`, async () => {
      const ts = normalize(await runTs(c, base));
      const want = normalize(py[c.name]!);
      expect(ts.error).toEqual(want.error);
      expect(ts.lines).toEqual(want.lines);
      expect(ts.payloads).toEqual(want.payloads);
      expect(ts.results).toEqual(want.results);
      expect(ts.lines.length).toBeGreaterThan(0);
    });
  }
});
