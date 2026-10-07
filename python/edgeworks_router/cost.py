"""Cost math (spec §6): priced by SERVED model via model_pricing; batch discount stacks with caching."""
from __future__ import annotations

from typing import Any

from .config import RoutingConfig


def usage_tokens(usage: Any) -> dict[str, int]:
    """Normalize SDK Usage / dict usage into the four billable counters (None -> 0)."""
    def g(name: str) -> int:
        if usage is None:
            return 0
        v = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)
        return int(v or 0)

    return {
        "input_tokens": g("input_tokens"),
        "output_tokens": g("output_tokens"),
        "cache_read_tokens": g("cache_read_input_tokens"),
        "cache_write_tokens": g("cache_creation_input_tokens"),
    }


def cost_for_alias(cfg: RoutingConfig, alias: str, tokens: dict[str, int], batch: bool) -> float:
    p = cfg.price_table(alias)
    raw = (tokens["input_tokens"] * p["input"]
           + tokens["output_tokens"] * p["output"]
           + tokens["cache_write_tokens"] * p["cache_write_5m"]
           + tokens["cache_read_tokens"] * p["cache_read"]) / 1e6
    if batch:
        raw *= cfg.batch_discount
    return round(raw, 6)


def compute_cost(cfg: RoutingConfig, served_model: str | None, requested_model: str,
                 tokens: dict[str, int], batch: bool) -> tuple[float, list[str]]:
    """Returns (cost_usd rounded to 6dp, extra adaptations). Unknown served model -> requested model's alias
    + 'pricing_fallback'. Neither known -> 0.0 + 'pricing_unknown'."""
    notes: list[str] = []
    alias = cfg.pricing_alias(served_model)
    if alias is None:
        alias = cfg.pricing_alias(requested_model)
        notes.append("pricing_fallback")
        if alias is None:
            notes.append("pricing_unknown")
            return 0.0, notes
    return cost_for_alias(cfg, alias, tokens, batch), notes
