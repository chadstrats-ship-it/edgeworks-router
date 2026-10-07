// Browser-safe sinks. The file sink lives in src/node.
import type { LogLine, PayloadRecord, RouteResult, RouterSink } from "./types.js";

/** Discards everything; totalSpend = 0. */
export const noopSink: RouterSink = {
  writeLine() {},
  savePayload() {},
  totalSpend() {
    return 0;
  },
};

export interface MemorySink extends RouterSink {
  lines: LogLine[];
  payloads: Map<string, PayloadRecord>;
  rejections: Map<string, RouteResult>;
}

/** In-memory sink (tests, in-app debugging). Supports reject(). */
export function createMemorySink(): MemorySink {
  const lines: LogLine[] = [];
  const payloads = new Map<string, PayloadRecord>();
  const rejections = new Map<string, RouteResult>();
  return {
    lines,
    payloads,
    rejections,
    writeLine(line) {
      lines.push(JSON.parse(JSON.stringify(line)) as LogLine);
    },
    savePayload(id, p) {
      payloads.set(id, JSON.parse(JSON.stringify(p)) as PayloadRecord);
    },
    totalSpend() {
      return lines.reduce((a, l) => a + (typeof l.cost_usd === "number" ? l.cost_usd : 0), 0);
    },
    loadPayload(id) {
      return payloads.get(id) ?? null;
    },
    saveRejection(id, r) {
      rejections.set(id, r);
    },
  };
}
