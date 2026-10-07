// File sink (SPEC §6): logs/router-YYYY-MM.jsonl (UTC month, append-only UTF-8), logs/payloads/<task_id>.json,
// logs/rejections/<task_id>.json; totalSpend sums cost_usd over every logs/router-*.jsonl, read incrementally.
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LogLine, PayloadRecord, RouteResult, RouterSink } from "../core/types.js";
import { resolveRouterHome, type Env } from "./config.js";

export interface FileSink extends RouterSink {
  readonly home: string;
  readonly logsDir: string;
}

function safeName(id: string): string {
  return id.replace(/[\\/:*?"<>|]/g, "_");
}

interface FileCache {
  offset: number;
  sum: number;
}

/** Sum of cost_usd across logs/router-*.jsonl with a per-file incremental byte-offset cache. */
export function createSpendCounter(logsDir: string): () => number {
  const cache = new Map<string, FileCache>();
  return () => {
    if (!existsSync(logsDir)) return 0;
    let total = 0;
    for (const name of readdirSync(logsDir)) {
      if (!/^router-.*\.jsonl$/.test(name)) continue;
      const p = join(logsDir, name);
      const size = statSync(p).size;
      let c = cache.get(p);
      if (!c || size < c.offset) c = { offset: 0, sum: 0 };
      if (size > c.offset) {
        const fd = openSync(p, "r");
        try {
          const buf = Buffer.alloc(size - c.offset);
          readSync(fd, buf, 0, buf.length, c.offset);
          const lastNl = buf.lastIndexOf(0x0a);
          if (lastNl >= 0) {
            const chunk = buf.subarray(0, lastNl + 1).toString("utf8");
            for (const line of chunk.split("\n")) {
              const t = line.trim();
              if (!t) continue;
              try {
                const o = JSON.parse(t) as { cost_usd?: unknown };
                if (typeof o.cost_usd === "number" && Number.isFinite(o.cost_usd)) c.sum += o.cost_usd;
              } catch {
                /* ignore malformed line */
              }
            }
            c.offset += lastNl + 1;
          }
        } finally {
          closeSync(fd);
        }
      }
      cache.set(p, c);
      total += c.sum;
    }
    return total;
  };
}

export function createFileSink(opts: { home?: string; env?: Env } = {}): FileSink {
  const home = opts.home ?? resolveRouterHome(opts.env ?? process.env);
  const logsDir = join(home, "logs");
  const payloadsDir = join(logsDir, "payloads");
  const rejectionsDir = join(logsDir, "rejections");
  const spend = createSpendCounter(logsDir);
  return {
    home,
    logsDir,
    writeLine(line: LogLine) {
      mkdirSync(logsDir, { recursive: true });
      const month = typeof line.timestamp === "string" ? line.timestamp.slice(0, 7) : new Date().toISOString().slice(0, 7);
      appendFileSync(join(logsDir, `router-${month}.jsonl`), JSON.stringify(line) + "\n", "utf8");
    },
    savePayload(taskId: string, payload: PayloadRecord) {
      mkdirSync(payloadsDir, { recursive: true });
      writeFileSync(join(payloadsDir, `${safeName(taskId)}.json`), JSON.stringify(payload, null, 2), "utf8");
    },
    totalSpend() {
      return spend();
    },
    loadPayload(taskId: string) {
      const p = join(payloadsDir, `${safeName(taskId)}.json`);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as PayloadRecord;
    },
    saveRejection(taskId: string, result: RouteResult) {
      mkdirSync(rejectionsDir, { recursive: true });
      writeFileSync(join(rejectionsDir, `${safeName(taskId)}.json`), JSON.stringify(result, null, 2), "utf8");
    },
  };
}

/** `router spend` equivalent: total cost_usd across all logs. */
export function totalSpend(opts: { home?: string; env?: Env } = {}): number {
  const home = opts.home ?? resolveRouterHome(opts.env ?? process.env);
  return createSpendCounter(join(home, "logs"))();
}
