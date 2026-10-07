// routing.json discovery + loading (SPEC §1 env: EDGEWORKS_ROUTER_HOME, EDGEWORKS_ROUTING_JSON).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RoutingConfig } from "../core/types.js";
import { moduleDir } from "./moduleDir.js";

export type Env = Record<string, string | undefined>;

/** Walk up from this module to the first directory containing routing.json (the edgeworks-router root). */
export function findRouterRoot(start: string = moduleDir): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "routing.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** EDGEWORKS_ROUTER_HOME, else the edgeworks-router root resolved relative to this package. */
export function resolveRouterHome(env: Env = process.env): string {
  const h = env.EDGEWORKS_ROUTER_HOME;
  if (h && h.trim()) return resolve(h);
  const root = findRouterRoot();
  if (!root) {
    throw new Error(
      "edgeworks-router root not found (no routing.json above the package); set EDGEWORKS_ROUTER_HOME",
    );
  }
  return root;
}

/** EDGEWORKS_ROUTING_JSON, else <home>/routing.json, else <package root>/routing.json. */
export function resolveConfigPath(env: Env = process.env): string {
  const p = env.EDGEWORKS_ROUTING_JSON;
  if (p && p.trim()) return resolve(p);
  const h = env.EDGEWORKS_ROUTER_HOME;
  if (h && h.trim() && existsSync(join(resolve(h), "routing.json"))) return join(resolve(h), "routing.json");
  const root = findRouterRoot();
  if (!root) throw new Error("routing.json not found; set EDGEWORKS_ROUTING_JSON or EDGEWORKS_ROUTER_HOME");
  return join(root, "routing.json");
}

export function loadConfig(path?: string, env: Env = process.env): RoutingConfig {
  const p = path ? resolve(path) : resolveConfigPath(env);
  const raw = readFileSync(p, "utf8").replace(/^﻿/, "");
  const cfg = JSON.parse(raw) as RoutingConfig;
  if (!cfg || typeof cfg !== "object" || !cfg.models || !cfg.defaults || !cfg.pricing) {
    throw new Error(`invalid routing.json at ${p}: missing models/defaults/pricing`);
  }
  cfg.pipelines = cfg.pipelines ?? {};
  return cfg;
}
