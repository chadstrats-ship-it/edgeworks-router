// @edgeworks/router/node — Node-only additions: routing.json loading, file sink, command validator,
// env-driven defaults (ANTHROPIC_API_KEY, EDGEWORKS_ROUTER_SPEND_CAP_USD). Re-exports the core API.
import { createRouter } from "../core/router.js";
import { RouterConfigError } from "../core/errors.js";
import type { CreateRouterOptions, Router, RoutingConfig } from "../core/types.js";
import { createCommandRunner } from "./command.js";
import { loadConfig, resolveRouterHome, type Env } from "./config.js";
import { createFileSink } from "./fileSink.js";

export * from "../core/index.js";
export { loadConfig, resolveConfigPath, resolveRouterHome, findRouterRoot, type Env } from "./config.js";
export { createFileSink, createSpendCounter, totalSpend, type FileSink } from "./fileSink.js";
export { createCommandRunner } from "./command.js";

export interface NodeRouterOptions extends Partial<Omit<CreateRouterOptions, "config">> {
  /** Config object; default loadConfig(configPath). */
  config?: RoutingConfig;
  configPath?: string;
  /** Router home (logs/ live under it); default EDGEWORKS_ROUTER_HOME or the edgeworks-router root. */
  home?: string;
  /** Environment to read (default process.env). */
  env?: Env;
}

export function parseSpendCap(env: Env): number | null {
  const v = env.EDGEWORKS_ROUTER_SPEND_CAP_USD;
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v.trim());
  if (!Number.isFinite(n)) throw new RouterConfigError(`EDGEWORKS_ROUTER_SPEND_CAP_USD is not a number: '${v}'`);
  return n;
}

/** createRouter with Node defaults: routing.json, file sink, env API key + spend cap, command validator. */
export function createNodeRouter(opts: NodeRouterOptions = {}): Router {
  const env = opts.env ?? process.env;
  const { configPath, home, env: _e, ...rest } = opts;
  const config = opts.config ?? loadConfig(configPath, env);
  const sink = opts.sink ?? createFileSink({ home: home ?? resolveRouterHome(env) });
  const apiKey = opts.apiKey ?? env.ANTHROPIC_API_KEY;
  const spendCapUsd = opts.spendCapUsd !== undefined ? opts.spendCapUsd : parseSpendCap(env);
  const full: CreateRouterOptions = {
    ...rest,
    config,
    sink,
    spendCapUsd,
    commandRunner: opts.commandRunner ?? createCommandRunner(),
  };
  if (apiKey) full.apiKey = apiKey;
  return createRouter(full);
}
