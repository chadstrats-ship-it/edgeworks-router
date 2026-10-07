"""routing.json loading, home/paths, effective ladder, pricing (spec §1, §2, §6)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import RouterConfigError

# <root>/python/edgeworks_router/config.py -> parents[2] == <root>
PACKAGE_ROOT = Path(__file__).resolve().parents[2]


def router_home() -> Path:
    """EDGEWORKS_ROUTER_HOME, default = the edgeworks-router root."""
    env = os.environ.get("EDGEWORKS_ROUTER_HOME")
    return Path(env) if env else PACKAGE_ROOT


def routing_json_path() -> Path:
    """EDGEWORKS_ROUTING_JSON > <home>/routing.json (if present) > <package root>/routing.json."""
    env = os.environ.get("EDGEWORKS_ROUTING_JSON")
    if env:
        return Path(env)
    home_cfg = router_home() / "routing.json"
    if home_cfg.is_file():
        return home_cfg
    return PACKAGE_ROOT / "routing.json"


def spend_cap() -> float | None:
    raw = os.environ.get("EDGEWORKS_ROUTER_SPEND_CAP_USD")
    if raw is None or raw.strip() == "":
        return None
    try:
        return float(raw)
    except ValueError as exc:
        raise RouterConfigError(f"EDGEWORKS_ROUTER_SPEND_CAP_USD is not a number: {raw!r}") from exc


@dataclass(frozen=True)
class Step:
    """One resolved ladder step."""
    index: int          # 0-based index into the effective ladder
    model: str          # literal model id sent to the API
    alias: str | None   # models{} alias key if the ladder used one
    effort: str | None  # null = omit output_config.effort

    @property
    def number(self) -> int:  # 1-based, as logged
        return self.index + 1


class RoutingConfig:
    def __init__(self, data: dict[str, Any], path: Path | None = None):
        self.data = data
        self.path = path
        for key in ("models", "pricing", "model_pricing", "defaults", "pipelines"):
            if key not in data:
                raise RouterConfigError(f"routing.json missing '{key}'")

    # ---- loading -------------------------------------------------------------------------------
    @classmethod
    def load(cls, path: str | os.PathLike | None = None) -> "RoutingConfig":
        p = Path(path) if path else routing_json_path()
        try:
            with open(p, "r", encoding="utf-8") as fh:
                return cls(json.load(fh), p)
        except FileNotFoundError as exc:
            raise RouterConfigError(f"routing.json not found at {p}") from exc

    # ---- accessors -----------------------------------------------------------------------------
    @property
    def models(self) -> dict[str, str]:
        return self.data["models"]

    @property
    def defaults(self) -> dict[str, Any]:
        return self.data["defaults"]

    @property
    def batch_discount(self) -> float:
        return float(self.data.get("batch_discount", 0.5))

    @property
    def report_cfg(self) -> dict[str, Any]:
        return self.data.get("report", {})

    @property
    def retry_cfg(self) -> dict[str, Any]:
        r = {"max_retries": 4, "base_ms": 1000, "max_ms": 30000}
        r.update(self.defaults.get("retry", {}))
        return r

    @property
    def batch_poll_seconds(self) -> float:
        return float(self.defaults.get("batch_poll_seconds", 30))

    def pipeline(self, name: str) -> dict[str, Any]:
        p = self.data["pipelines"].get(name)
        if p is None or name.startswith("<"):
            raise RouterConfigError(f"unknown pipeline '{name}'")
        return p

    def resolve_model(self, model: str) -> tuple[str, str | None]:
        """Ladder `model` is an alias key of models{} or a literal id. Returns (model_id, alias|None)."""
        if model in self.models:
            return self.models[model], model
        return model, None

    def pricing_alias(self, model_id: str | None) -> str | None:
        if model_id is None:
            return None
        if model_id in self.data["model_pricing"]:
            return self.data["model_pricing"][model_id]
        if model_id in self.data["pricing"]:  # alias used directly
            return model_id
        return None

    def price_table(self, alias: str) -> dict[str, float]:
        return self.data["pricing"][alias]

    def is_haiku(self, model_id: str) -> bool:
        return self.pricing_alias(model_id) == "haiku" or "haiku" in model_id

    def is_opus(self, model_id: str) -> bool:
        return self.pricing_alias(model_id) == "opus" or model_id == self.models.get("opus")

    def effective_ladder(self, pipeline: dict[str, Any], critical: bool | None = None) -> list[Step]:
        """pinned_model -> single step; else pipeline.ladder ?? defaults.ladder, drop critical_only unless
        critical, truncate to max_attempts."""
        is_critical = bool(pipeline.get("critical", False)) if critical is None else bool(critical)
        pinned = pipeline.get("pinned_model")
        if pinned:
            mid, alias = self.resolve_model(pinned)
            return [Step(0, mid, alias, None)]
        raw = pipeline.get("ladder") or self.defaults["ladder"]
        raw = [s for s in raw if is_critical or not s.get("critical_only", False)]
        max_attempts = pipeline.get("max_attempts") or self.defaults.get("max_attempts", len(raw))
        raw = raw[: int(max_attempts)]
        steps = []
        for i, s in enumerate(raw):
            mid, alias = self.resolve_model(s["model"])
            steps.append(Step(i, mid, alias, s.get("effort")))
        if not steps:
            raise RouterConfigError("effective ladder is empty")
        return steps

    def grader_threshold(self, pipeline: dict[str, Any]) -> float:
        g = pipeline.get("grader") or {}
        t = g.get("threshold")
        return float(t if t is not None else self.defaults.get("grader_threshold", 7))
