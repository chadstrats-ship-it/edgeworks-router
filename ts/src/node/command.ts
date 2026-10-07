// `command` validator runner (SPEC §4): write output to a temp file, run cmd with "{file}" substituted,
// pass iff exit 0. No shell (args passed verbatim).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../core/types.js";

export function createCommandRunner(opts: { timeoutMs?: number } = {}): CommandRunner {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return async (cmd, output) => {
    if (!Array.isArray(cmd) || cmd.length === 0) return 127;
    const dir = mkdtempSync(join(tmpdir(), "edgeworks-router-"));
    const isText = typeof output === "string";
    const file = join(dir, isText ? "output.txt" : "output.json");
    writeFileSync(file, isText ? (output as string) : JSON.stringify(output, null, 2), "utf8");
    const args = cmd.map((a) => a.split("{file}").join(file));
    try {
      return await new Promise<number>((resolve) => {
        let settled = false;
        const done = (code: number) => {
          if (!settled) {
            settled = true;
            resolve(code);
          }
        };
        const child = spawn(args[0] as string, args.slice(1), { stdio: "ignore", shell: false, windowsHide: true });
        const timer = setTimeout(() => {
          child.kill();
          done(124);
        }, timeoutMs);
        child.on("error", () => {
          clearTimeout(timer);
          done(127);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done(code ?? 1);
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
