// Runs EVERY case in shared/fixtures/parity.json (cross-language contract with the Python suite).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemorySink, createRouter } from "../src/core/index.js";
import type { Message, ValidatorSpec } from "../src/core/types.js";
import { TEST_KEY, USER_PARAMS, fakeSleep, getPath, makeConfig, mockBatchFetch, mockFetch, pipe } from "./helpers.js";

interface ParityCase {
  name: string;
  batch?: boolean;
  request?: Record<string, unknown>;
  validators: ValidatorSpec[];
  responses: Message[];
  expect: {
    status?: string;
    final_step?: number;
    sent_request?: Record<string, unknown>;
    lines?: Array<Record<string, unknown>>;
  };
}

const fixture = JSON.parse(readFileSync(join(__dirname, "..", "..", "shared", "fixtures", "parity.json"), "utf8")) as { cases: ParityCase[] };

describe("parity fixture (shared/fixtures/parity.json)", () => {
  it("fixture loaded", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(7);
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      // parity pipelines: default ladder, non-critical, max_attempts 3
      const config = makeConfig({ p: pipe({ validators: c.validators, batchable: !!c.batch, critical: false, max_attempts: 3 }) });
      const sink = createMemorySink();
      const params = (c.request ?? USER_PARAMS) as any;
      let result: any;
      let firstSent: any;
      if (c.batch) {
        const m = mockBatchFetch(({ round }) => ({ type: "succeeded", message: c.responses[round]! }));
        const router = createRouter({ config, fetch: m.fetch, sink, apiKey: TEST_KEY, sleep: fakeSleep().sleep });
        [result] = await router.routeBatch("p", [{ params }]);
        firstSent = m.batches[0]!.requests[0]!.params;
      } else {
        const m = mockFetch(c.responses);
        const router = createRouter({ config, fetch: m.fetch, sink, apiKey: TEST_KEY, sleep: fakeSleep().sleep });
        result = await router.route("p", params);
        firstSent = m.calls[0]!.body;
        expect(m.calls).toHaveLength(Math.min(c.responses.length, m.calls.length));
      }
      if (c.expect.status !== undefined) expect(result.status).toBe(c.expect.status);
      if (c.expect.final_step !== undefined) expect(result.final_step).toBe(c.expect.final_step);
      if (c.expect.sent_request) {
        for (const [path, want] of Object.entries(c.expect.sent_request)) {
          const got = getPath(firstSent, path);
          if (want === "<absent>") expect(got, path).toBeUndefined();
          else expect(got, path).toEqual(want);
        }
      }
      const lines = sink.lines.filter((l) => l.role === "attempt");
      const want = c.expect.lines ?? [];
      expect(lines.length).toBeGreaterThanOrEqual(want.length);
      want.forEach((w, i) => {
        const got = lines[i]!;
        for (const [k, v] of Object.entries(w)) {
          if (k === "adaptations_include") {
            for (const a of v as string[]) expect(got.adaptations, `line ${i} adaptations`).toContain(a);
          } else {
            expect(got[k], `line ${i} ${k}`).toEqual(v);
          }
        }
      });
    });
  }
});
