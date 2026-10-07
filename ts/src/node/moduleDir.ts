// Directory of this compiled module. ESM build uses import.meta.url; scripts/build.mjs overwrites the
// CJS output of this file with `exports.moduleDir = __dirname` (import.meta is a syntax error in CJS).
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// @ts-ignore -- TS1343 under the CommonJS build; the emitted CJS file is replaced post-build.
export const moduleDir: string = dirname(fileURLToPath(import.meta.url));
