import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CORE = join(__dirname, "..", "src", "core");

describe("core purity (browser / React-Native safe)", () => {
  it("src/core has no node imports and no process/fs/path usage", () => {
    const offenders: string[] = [];
    const files = readdirSync(CORE).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    const importRe = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
    for (const f of files) {
      const src = readFileSync(join(CORE, f), "utf8");
      for (const m of src.matchAll(importRe)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? "";
        if (!spec.startsWith("./")) offenders.push(`${f}: imports '${spec}'`);
        if (/^node:|^(fs|path|os|child_process|crypto|url|process|buffer)(\/|$)/.test(spec)) offenders.push(`${f}: node module '${spec}'`);
      }
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      if (/\bprocess\s*\.\s*(env|argv|cwd|exit)/.test(code)) offenders.push(`${f}: uses process.*`);
      if (/\bBuffer\b/.test(code)) offenders.push(`${f}: uses Buffer`);
      if (/\b__dirname\b|\bimport\.meta\b/.test(code)) offenders.push(`${f}: uses module paths`);
      if (/['"]node:/.test(code)) offenders.push(`${f}: mentions node: specifier`);
    }
    expect(offenders).toEqual([]);
  });
});
