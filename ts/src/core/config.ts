// Ladder resolution + cost math (SPEC §2, §6). Mirrors python/edgeworks_router/config.py + cost.py.
import type { PipelineConfig, ResolvedStep, RoutingConfig } from "./types.js";
import { RouterConfigError } from "./errors.js";

export function getPipeline(config: RoutingConfig, name: string): PipelineConfig {
  const p = config.pipelines?.[name];
  if (!p || name.startsWith("<")) throw new RouterConfigError(`unknown pipeline '${name}'`);
  return p;
}

/** Ladder `model` is an alias key of models{} or a literal id. */
export function resolveModel(config: RoutingConfig, model: string): { model: string; alias: string | null } {
  if (Object.prototype.hasOwnProperty.call(config.models ?? {}, model)) return { model: config.models[model] as string, alias: model };
  return { model, alias: null };
}

/** model_pricing[model] ?? (model if it is a pricing alias) ?? null */
export function pricingAlias(config: RoutingConfig, modelId: string | null | undefined): string | null {
  if (modelId === null || modelId === undefined) return null;
  const mp = config.model_pricing ?? {};
  if (Object.prototype.hasOwnProperty.call(mp, modelId)) return mp[modelId] as string;
  if (Object.prototype.hasOwnProperty.call(config.pricing ?? {}, modelId)) return modelId;
  return null;
}

export function isHaikuModel(config: RoutingConfig, modelId: string): boolean {
  return pricingAlias(config, modelId) === "haiku" || modelId.includes("haiku");
}

export function isOpusModel(config: RoutingConfig, modelId: string): boolean {
  return pricingAlias(config, modelId) === "opus" || modelId === config.models?.opus;
}

/**
 * pinned_model -> single step (effort null); else pipeline.ladder || defaults.ladder, drop critical_only
 * unless critical (option overrides pipeline.critical), truncate to max_attempts.
 */
export function effectiveLadder(config: RoutingConfig, pipeline: PipelineConfig, critical?: boolean | null): ResolvedStep[] {
  const isCritical = critical === undefined || critical === null ? Boolean(pipeline.critical ?? false) : Boolean(critical);
  if (pipeline.pinned_model) {
    const r = resolveModel(config, pipeline.pinned_model);
    return [{ step: 1, alias: r.alias, model: r.model, effort: null }];
  }
  let raw = pipeline.ladder && pipeline.ladder.length > 0 ? pipeline.ladder : config.defaults.ladder;
  raw = raw.filter((s) => isCritical || !s.critical_only);
  const maxAttempts = pipeline.max_attempts || config.defaults.max_attempts || raw.length;
  raw = raw.slice(0, Math.trunc(maxAttempts));
  const steps = raw.map((s, i) => {
    const r = resolveModel(config, s.model);
    return { step: i + 1, alias: r.alias, model: r.model, effort: s.effort ?? null };
  });
  if (steps.length === 0) throw new RouterConfigError("effective ladder is empty");
  return steps;
}

export function graderThreshold(config: RoutingConfig, pipeline: PipelineConfig): number {
  const t = pipeline.grader?.threshold;
  return t !== null && t !== undefined ? Number(t) : Number(config.defaults.grader_threshold ?? 7);
}

/** Round to 6 decimal places (matches Python round(x, 6) for all non-tie doubles). */
export function round6(x: number): number {
  const r = Number(x.toFixed(6));
  return Object.is(r, -0) ? 0 : r;
}

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostResult {
  cost_usd: number;
  /** extra adaptations: "pricing_fallback", "pricing_unknown" */
  notes: string[];
}

export function usageTokens(usage: unknown): TokenCounts {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
  const g = (k: string): number => {
    const v = u[k];
    return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
  };
  return {
    input_tokens: g("input_tokens"),
    output_tokens: g("output_tokens"),
    cache_read_tokens: g("cache_read_input_tokens"),
    cache_write_tokens: g("cache_creation_input_tokens"),
  };
}

export function costForAlias(config: RoutingConfig, alias: string, t: TokenCounts, batch: boolean): number {
  const p = config.pricing[alias];
  if (!p) return 0;
  let raw =
    (t.input_tokens * p.input + t.output_tokens * p.output + t.cache_write_tokens * p.cache_write_5m + t.cache_read_tokens * p.cache_read) /
    1e6;
  if (batch) raw *= config.batch_discount ?? 0.5;
  return round6(raw);
}

/**
 * cost_usd priced by SERVED model via model_pricing. Unknown served -> requested model's alias +
 * "pricing_fallback"; neither known -> 0 + "pricing_unknown".
 */
export function computeCost(config: RoutingConfig, servedModel: string | null, requestedModel: string, t: TokenCounts, batch: boolean): CostResult {
  const notes: string[] = [];
  let alias = pricingAlias(config, servedModel);
  if (alias === null) {
    alias = pricingAlias(config, requestedModel);
    notes.push("pricing_fallback");
    if (alias === null) {
      notes.push("pricing_unknown");
      return { cost_usd: 0, notes };
    }
  }
  return { cost_usd: costForAlias(config, alias, t, batch), notes };
}
