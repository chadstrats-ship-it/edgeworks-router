"""Attempt evaluation (spec §4): stop_reason gate, extraction, ordered validators, custom registry."""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable

from .schema import validate as schema_validate

FAIL_STOP_REASONS = ("max_tokens", "refusal", "model_context_window_exceeded", "pause_turn")

# name -> fn(output_value, ctx{step, message, text}) -> (ok, reason)
CustomValidator = Callable[[Any, dict[str, Any]], "tuple[bool, str | None]"]
VALIDATORS: dict[str, CustomValidator] = {}


def register_validator(name: str, fn: CustomValidator | None = None):
    """Register a custom validator globally. Usable as a decorator: @register_validator("name")."""
    if fn is None:
        def deco(f: CustomValidator) -> CustomValidator:
            VALIDATORS[name] = f
            return f
        return deco
    VALIDATORS[name] = fn
    return fn


@register_validator("fail_on_step_1")
def _fail_on_step_1(output: Any, ctx: dict[str, Any]) -> tuple[bool, str | None]:
    """Built-in (both languages): fails iff step == 1. Used by the smoke-force-escalation pipeline."""
    if ctx.get("step") == 1:
        return False, "step_1"
    return True, None


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def extract(message: Any) -> tuple[str, list[Any]]:
    """text = all text blocks joined by '\\n', trimmed; tool_uses = tool_use blocks. Reads by type, never content[0]."""
    texts, tool_uses = [], []
    for b in _attr(message, "content", None) or []:
        t = _attr(b, "type")
        if t == "text":
            texts.append(_attr(b, "text", "") or "")
        elif t == "tool_use":
            tool_uses.append(b)
    return "\n".join(texts).strip(), tool_uses


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-standard JSON constant {name}")


_FENCE = re.compile(r"```[a-zA-Z0-9_-]*\s*\n?(.*?)```", re.S)


def parse_json_text(text: str, extract_kind: str | None) -> Any:
    s = text.strip()
    m = _FENCE.search(s)
    if m:
        s = m.group(1).strip()
    if extract_kind in ("array", "object"):
        open_c, close_c = ("[", "]") if extract_kind == "array" else ("{", "}")
        i, j = s.find(open_c), s.rfind(close_c)
        if i < 0 or j < i:
            raise ValueError("no json span")
        s = s[i:j + 1]
    return json.loads(s, parse_constant=_reject_constant)


def is_deterministic(v: dict[str, Any], registry: dict[str, CustomValidator]) -> bool:
    """A validator counts as deterministic unless it is a custom one that is unavailable in this process."""
    return not (v.get("type") == "custom" and v.get("name") not in registry)


@dataclass
class Evaluation:
    passed: bool
    reason: str | None
    output: Any
    text: str
    score: float
    notes: list[str] = field(default_factory=list)


def evaluate(message: Any, validators: list[dict[str, Any]], step: int,
             registry: dict[str, CustomValidator] | None = None) -> Evaluation:
    registry = VALIDATORS if registry is None else registry
    stop = _attr(message, "stop_reason")
    text, tool_uses = extract(message)
    if stop in FAIL_STOP_REASONS:
        return Evaluation(False, f"stop_reason:{stop}", text, text, 0.0)
    if not text and not tool_uses:
        return Evaluation(False, "empty", text, text, 0.0)

    output: Any = text
    notes: list[str] = []
    total = len(validators)
    passed_n = 0
    ctx = {"step": step, "message": message, "text": text}

    def done(ok: bool, reason: str | None) -> Evaluation:
        parts = ([reason] if reason else []) + notes
        full_reason = "; ".join(parts) if parts else None
        score = 1.0 if ok else (passed_n / total if total else 0.0)
        return Evaluation(ok, full_reason, output, text, score, notes=notes)

    for v in validators:
        vt = v.get("type")
        if vt == "tool_use":
            name = v.get("name")
            hit = next((b for b in tool_uses if _attr(b, "name") == name), None)
            if hit is None:
                return done(False, f"tool_use_missing:{name}")
            output = _attr(hit, "input")
        elif vt == "json":
            if isinstance(output, str):
                try:
                    output = parse_json_text(output, v.get("extract"))
                except (ValueError, json.JSONDecodeError):
                    return done(False, "json_parse")
        elif vt == "json_schema":
            r = schema_validate(output, v.get("schema") or {})
            if r:
                return done(False, f"schema:{r[0]}:{r[1]}")
        elif vt == "required_fields":
            fields = v.get("fields") or []
            objs = output if isinstance(output, list) else [output]
            for f in fields:
                for o in objs:
                    if not isinstance(o, dict) or f not in o:
                        return done(False, f"required_fields:{f}")
        elif vt == "length":
            n = len(text)
            if (v.get("min") is not None and n < v["min"]) or (v.get("max") is not None and n > v["max"]):
                return done(False, "length")
        elif vt == "regex":
            found = re.search(v.get("pattern", ""), text) is not None
            if found != bool(v.get("must_match", True)):
                return done(False, "regex")
        elif vt == "banned_phrases":
            ci = v.get("case_insensitive", True)
            hay = text.lower() if ci else text
            for ph in v.get("phrases") or []:
                if (ph.lower() if ci else ph) in hay:
                    return done(False, f"banned_phrase:{ph}")
        elif vt == "command":
            code = _run_command(v.get("cmd") or [], output, v.get("timeout_s", 120))
            if code != 0:
                return done(False, f"command_exit:{code}")
        elif vt == "custom":
            name = v.get("name")
            fn = registry.get(name)
            if fn is None:
                notes.append(f"custom:{name}:unavailable")
            else:
                ok, why = fn(output, ctx)
                if not ok:
                    return done(False, f"custom:{name}" + (f":{why}" if why else ""))
        else:
            notes.append(f"unknown_validator:{vt}")
        passed_n += 1
    return done(True, None)


def _run_command(cmd: list[str], output: Any, timeout_s: float) -> int | str:
    data = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    fd, path = tempfile.mkstemp(prefix="edgeworks-router-", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
        argv = [a.replace("{file}", path) for a in cmd]
        try:
            return subprocess.run(argv, capture_output=True, timeout=timeout_s).returncode
        except subprocess.TimeoutExpired:
            return "timeout"
        except OSError:
            return "oserror"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
