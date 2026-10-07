// Dual build: dist/esm (ESM, package type module) + dist/cjs (CommonJS, nested {"type":"commonjs"}).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const run = (project) => execFileSync(process.execPath, [tsc, "-p", join(root, project)], { stdio: "inherit", cwd: root });

rmSync(join(root, "dist"), { recursive: true, force: true });
run("tsconfig.esm.json");
run("tsconfig.cjs.json");
mkdirSync(join(root, "dist", "cjs"), { recursive: true });
writeFileSync(join(root, "dist", "cjs", "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
writeFileSync(
  join(root, "dist", "cjs", "node", "moduleDir.js"),
  '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.moduleDir = void 0;\nexports.moduleDir = __dirname;\n',
);
console.log("build ok: dist/esm + dist/cjs");
