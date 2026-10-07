"""Request adaptation (spec §3). Pure: never mutates the call-site params."""
from __future__ import annotations

import copy
from typing import Any

from .config import RoutingConfig
from .errors import PrefillNotSupported
from .schema import sanitize_strict_schema


def check_prefill(params: dict[str, Any]) -> None:
    msgs = params.get("messages") or []
    if msgs and _role(msgs[-1]) == "assistant":
        raise PrefillNotSupported(
            "last message has role 'assistant' (prefill) - not supported on Sonnet 5.5 / Opus 5.5; "
            "restructure the prompt instead")


def _role(m: Any) -> Any:
    return m.get("role") if isinstance(m, dict) else getattr(m, "role", None)


def original_params(params: dict[str, Any]) -> dict[str, Any]:
    """Payload form: call-site params minus `model` (and never headers/keys)."""
    p = copy.deepcopy(dict(params))
    p.pop("model", None)
    for k in list(p.keys()):
        lk = k.lower()
        if lk in ("extra_headers", "headers", "api_key", "x-api-key", "authorization") or "api_key" in lk:
            p.pop(k, None)
    return p


def _strictify_tool(tool: dict[str, Any], adaptations: list[str]) -> None:
    if not isinstance(tool.get("input_schema"), dict):
        return
    new_schema, stripped = sanitize_strict_schema(tool["input_schema"])
    tool["input_schema"] = new_schema
    for s in stripped:
        adaptations.append(f"strict_strip:{tool.get('name')}{s}")


def adapt_request(cfg: RoutingConfig, params: dict[str, Any], model_id: str,
                  effort: str | None) -> tuple[dict[str, Any], list[str]]:
    """Returns (params_to_send, adaptations). Raises PrefillNotSupported."""
    check_prefill(params)
    sent = copy.deepcopy(dict(params))
    adaptations: list[str] = []

    # 1. model + effort (never effort to Haiku)
    sent["model"] = model_id
    haiku = cfg.is_haiku(model_id)
    oc = sent.get("output_config")
    oc = dict(oc) if isinstance(oc, dict) else {}
    if haiku:
        if "effort" in oc:
            oc.pop("effort")
            adaptations.append("effort_removed_haiku")
    elif effort is not None:
        oc["effort"] = effort
    if oc:
        sent["output_config"] = oc
    else:
        sent.pop("output_config", None)

    # 2. forced tool use -> auto + strict
    tc = sent.get("tool_choice")
    tools = sent.get("tools")
    if isinstance(tc, dict) and tc.get("type") in ("tool", "any") and isinstance(tools, list):
        forced_name = tc.get("name") if tc.get("type") == "tool" else None
        new_tc: dict[str, Any] = {"type": "auto"}
        if "disable_parallel_tool_use" in tc:
            new_tc["disable_parallel_tool_use"] = tc["disable_parallel_tool_use"]
        sent["tool_choice"] = new_tc
        for t in tools:
            if not isinstance(t, dict) or "input_schema" not in t:
                continue  # server tools have no input_schema
            if forced_name is None or t.get("name") == forced_name:
                t["strict"] = True
        adaptations.append("forced_tool_use->auto_strict")
    # every strict tool (router-marked or call-site-marked) gets a sanitized schema
    if isinstance(tools, list):
        for t in tools:
            if isinstance(t, dict) and t.get("strict") is True:
                _strictify_tool(t, adaptations)
    fmt = oc.get("format") if oc else None
    if isinstance(fmt, dict) and isinstance(fmt.get("schema"), dict):
        new_schema, stripped = sanitize_strict_schema(fmt["schema"])
        sent["output_config"]["format"] = {**fmt, "schema": new_schema}
        adaptations.extend(f"strict_strip:output_format{s}" for s in stripped)

    # 3. sampling params
    if "temperature" in sent and sent["temperature"] != 1:
        del sent["temperature"]
        adaptations.append("temperature_removed")
    if "top_k" in sent:
        del sent["top_k"]
        adaptations.append("top_k_removed")
    if "top_p" in sent and sent["top_p"] is not None and sent["top_p"] < 0.99:
        del sent["top_p"]
        adaptations.append("top_p_removed")

    # 4. thinking
    th = sent.get("thinking")
    if isinstance(th, dict):
        if th.get("type") == "disabled":
            sent["thinking"] = {"type": "between_tools"}
            adaptations.append("thinking_disabled->between_tools")
        elif th.get("type") == "enabled":
            sent["thinking"] = {"type": "adaptive"}
            adaptations.append("thinking_enabled->adaptive")

    # router is non-streaming
    if sent.pop("stream", None):
        adaptations.append("stream_removed")
    return sent, adaptations
