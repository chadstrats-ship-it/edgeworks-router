"""Routing loop (spec §5), logging (§6), batch mode (§7), reject re-run (§8).

The loop is written ONCE as a generator that yields I/O effects:
    ("call", sdk_kwargs) ("sleep", seconds) ("batch_create", requests) ("batch_retrieve", id) ("batch_results", id)
and is driven either synchronously (route/route_batch) or asynchronously (aroute/aroute_batch).
Exceptions raised by the client are thrown back into the generator at the yield point.
"""
from __future__ import annotations

import asyncio
import inspect
import random
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Generator

import anthropic
from anthropic.resources.messages import Messages as _SDKMessages

from .adapt import adapt_request, check_prefill, original_params
from .config import RoutingConfig, Step, spend_cap
from .cost import compute_cost, cost_for_alias, usage_tokens
from .errors import (RouterConfigError, RouterInfraError, RouterRequestError, SpendCapExceeded)
from .sinks import FileSink
from .validators import VALIDATORS, Evaluation, CustomValidator, evaluate, is_deterministic, parse_json_text

LANG = "py"
DEFAULT_REQUEST_TIMEOUT_S = 900.0  # explicit timeout also bypasses the SDK's non-streaming long-request guard
CUSTOM_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

GRADER_SYSTEM_PROMPT = (
    "You are a strict quality grader. You will receive a RUBRIC, the ORIGINAL REQUEST (user text only) and a "
    "CANDIDATE RESPONSE. Score how well the candidate satisfies the rubric and the request on an integer scale "
    "0-10 (10 = fully correct and complete, 0 = unusable). Respond with ONLY a JSON object, no prose, exactly: "
    '{"score": <integer 0-10>, "reason": "<one short sentence>"}'
)

# Patch points for tests (looked up at call time).
_sleep = time.sleep
_asleep = asyncio.sleep
_random = random.random

_SDK_KNOWN = set(inspect.signature(_SDKMessages.create).parameters) - {
    "self", "extra_headers", "extra_query", "extra_body", "timeout"}


# ---------------------------------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------------------------------

@dataclass
class Attempt:
    step: int
    model: str
    effort: str | None
    passed: bool
    reason: str | None
    cost_usd: float
    # internal (not part of the spec'd attempts[] shape)
    served_model: str | None = field(default=None, repr=False)
    score: float = field(default=0.0, repr=False)
    message: Any = field(default=None, repr=False)
    output: Any = field(default=None, repr=False)
    text: str = field(default="", repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {"step": self.step, "model": self.model, "effort": self.effort, "passed": self.passed,
                "reason": self.reason, "cost_usd": self.cost_usd}


@dataclass
class RouteResult:
    status: str                 # "passed" | "escalated_passed" | "failed_all"
    task_id: str
    final_step: int
    message: Any                # raw SDK Message (None if the best attempt had no message, e.g. batch errored)
    output: Any
    text: str
    served_model: str | None
    total_cost_usd: float
    attempts: list[Attempt]

    @property
    def passed(self) -> bool:
        return self.status != "failed_all"

    def to_dict(self) -> dict[str, Any]:
        msg = self.message
        if msg is not None and hasattr(msg, "model_dump"):
            msg = msg.model_dump(mode="json", exclude_none=True)
        return {"status": self.status, "task_id": self.task_id, "final_step": self.final_step,
                "message": msg, "output": self.output, "text": self.text, "served_model": self.served_model,
                "total_cost_usd": self.total_cost_usd, "attempts": [a.to_dict() for a in self.attempts]}


# ---------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------

def _attr(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_name(pipeline: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", pipeline)


def new_task_id(pipeline: str) -> str:
    """<pipeline>-<yyyymmddHHMMSS>-<8 hex>"""
    return f"{_safe_name(pipeline)}-{datetime.now(timezone.utc):%Y%m%d%H%M%S}-{secrets.token_hex(4)}"


def custom_id_for(task_id: str) -> str:
    """Batch custom_id: the task_id, or (if > 64 chars) its pipeline prefix truncated so the unique
    '-<timestamp>-<hex>' suffix (24 chars) is always kept."""
    safe = _safe_name(task_id)
    if len(safe) <= 64:
        return safe
    return safe[: 64 - 24] + safe[-24:]


def to_sdk_kwargs(sent: dict[str, Any], headers: dict[str, str] | None, timeout: float | None) -> dict[str, Any]:
    """Split params into typed SDK kwargs and extra_body (fields the installed SDK does not type)."""
    kw = {k: v for k, v in sent.items() if k in _SDK_KNOWN}
    extra = {k: v for k, v in sent.items() if k not in _SDK_KNOWN}
    if extra:
        kw["extra_body"] = extra
    if headers:
        kw["extra_headers"] = dict(headers)
    if timeout is not None:
        kw["timeout"] = timeout
    return kw


def _parse_retry_after_s(headers: Any) -> float | None:
    if headers is None:
        return None
    try:
        ms = headers.get("retry-after-ms")
        if ms is not None:
            return float(ms) / 1000.0
        ra = headers.get("retry-after")
        if ra is None:
            return None
        try:
            return float(ra)
        except ValueError:
            from email.utils import parsedate_to_datetime
            dt = parsedate_to_datetime(ra)
            return max(0.0, (dt - datetime.now(timezone.utc)).total_seconds())
    except Exception:  # malformed header -> ignore
        return None


def classify_error(exc: BaseException) -> tuple[bool, str, float | None] | None:
    """(retryable, code, retry_after_s) for API/infra errors; None for anything else (re-raised)."""
    if isinstance(exc, anthropic.APITimeoutError):
        return True, "timeout", None
    if isinstance(exc, anthropic.APIConnectionError):
        return True, "network", None
    if isinstance(exc, anthropic.APIStatusError):
        code = int(exc.status_code)
        retry_after = _parse_retry_after_s(getattr(exc.response, "headers", None))
        retryable = code in (408, 429, 529) or code >= 500
        return retryable, str(code), retry_after
    if isinstance(exc, TimeoutError):
        return True, "timeout", None
    if isinstance(exc, ConnectionError):
        return True, "network", None
    return None


def backoff_seconds(n: int, retry: dict[str, Any], retry_after_s: float | None) -> float:
    """min(max_ms, base_ms*2^n) * U(0.5, 1.0) full jitter; retry-after honored if larger."""
    ms = min(float(retry["max_ms"]), float(retry["base_ms"]) * (2 ** n)) * (0.5 + 0.5 * _random())
    if retry_after_s is not None and retry_after_s * 1000.0 > ms:
        ms = retry_after_s * 1000.0
    return ms / 1000.0


def _fmt_num(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else str(x)


def _user_text(params: dict[str, Any]) -> str:
    parts: list[str] = []
    for m in params.get("messages") or []:
        if _attr(m, "role") != "user":
            continue
        c = _attr(m, "content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for b in c:
                if _attr(b, "type") == "text":
                    parts.append(_attr(b, "text", "") or "")
    return "\n\n".join(p for p in parts if p)


# ---------------------------------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------------------------------

Gen = Generator[tuple[str, Any], Any, Any]


class Router:
    def __init__(self, config: RoutingConfig | dict | str | None = None, *, client: Any = None,
                 async_client: Any = None, sink: Any = None,
                 validators: dict[str, CustomValidator] | None = None,
                 request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT_S, lang: str = LANG):
        if isinstance(config, RoutingConfig):
            self.config = config
        elif isinstance(config, dict):
            self.config = RoutingConfig(config)
        else:
            self.config = RoutingConfig.load(config)
        self._client = client
        self._async_client = async_client
        self.sink = sink if sink is not None else FileSink()
        self.registry: dict[str, CustomValidator] = dict(VALIDATORS)
        if validators:
            self.registry.update(validators)
        self.request_timeout = request_timeout
        self.lang = lang

    # ---- public API ----------------------------------------------------------------------------
    def route(self, pipeline: str, params: dict[str, Any], *, critical: bool | None = None,
              task_id: str | None = None, headers: dict[str, str] | None = None) -> RouteResult:
        return self._drive(self._route_gen(pipeline, params, critical=critical, task_id=task_id, headers=headers))

    async def aroute(self, pipeline: str, params: dict[str, Any], *, critical: bool | None = None,
                     task_id: str | None = None, headers: dict[str, str] | None = None) -> RouteResult:
        return await self._adrive(self._route_gen(pipeline, params, critical=critical, task_id=task_id,
                                                  headers=headers))

    def route_batch(self, pipeline: str, items: list[dict[str, Any]], *, critical: bool | None = None,
                    headers: dict[str, str] | None = None,
                    poll_seconds: float | None = None) -> list[RouteResult]:
        return self._drive(self._batch_gen(pipeline, items, critical=critical, headers=headers,
                                           poll_seconds=poll_seconds))

    async def aroute_batch(self, pipeline: str, items: list[dict[str, Any]], *, critical: bool | None = None,
                           headers: dict[str, str] | None = None,
                           poll_seconds: float | None = None) -> list[RouteResult]:
        return await self._adrive(self._batch_gen(pipeline, items, critical=critical, headers=headers,
                                                  poll_seconds=poll_seconds))

    def reject(self, task_id: str, reason: str) -> RouteResult:
        """Log a human rejection and re-run from the first opus ladder step (spec §8)."""
        payload = self.sink.load_payload(task_id)
        if payload is None:
            raise RouterConfigError(f"no payload saved for task_id '{task_id}'")
        name = payload["pipeline"]
        params = payload["params"]
        pcfg = self.config.pipeline(name)
        ladder = self.config.effective_ladder(pcfg)
        start = next((s.index for s in ladder if self.config.is_opus(s.model)), len(ladder) - 1)
        n = 1
        while self.sink.load_payload(f"{task_id}-r{n}") is not None:
            n += 1
        new_id = f"{task_id}-r{n}"
        self.sink.write_line(self._line(
            task_id=task_id, pipeline=name, step=None, requested_model=None, served_model=None, effort=None,
            tokens=None, cost=0.0, latency_ms=0, passed=False, reason=f"human_rejected: {reason}",
            escalated=False, final=False, batch=False, role="rejection", stop_reason=None, retries=0,
            model_mismatch=False, extra={"human_rejected": True, "rejected_task_id": task_id}, adaptations=[]))
        return self._drive(self._route_gen(name, params, task_id=new_id, start_index=start,
                                           extra={"human_rejected": True, "rejected_task_id": task_id}))

    # ---- drivers --------------------------------------------------------------------------------
    def _sync_client(self) -> Any:
        if self._client is None:
            self._client = anthropic.Anthropic(max_retries=0)
        return self._client

    def _async_client_get(self) -> Any:
        if self._async_client is None:
            self._async_client = anthropic.AsyncAnthropic(max_retries=0)
        return self._async_client

    def _exec_sync(self, eff: tuple[str, Any]) -> Any:
        kind, arg = eff
        if kind == "sleep":
            return _sleep(arg)
        c = self._sync_client()
        if kind == "call":
            return c.messages.create(**arg)
        if kind == "batch_create":
            return c.messages.batches.create(requests=arg)
        if kind == "batch_retrieve":
            return c.messages.batches.retrieve(arg)
        if kind == "batch_results":
            return list(c.messages.batches.results(arg))
        raise RuntimeError(f"unknown effect {kind}")

    async def _exec_async(self, eff: tuple[str, Any]) -> Any:
        kind, arg = eff
        if kind == "sleep":
            return await _asleep(arg)
        c = self._async_client_get()
        if kind == "call":
            return await c.messages.create(**arg)
        if kind == "batch_create":
            return await c.messages.batches.create(requests=arg)
        if kind == "batch_retrieve":
            return await c.messages.batches.retrieve(arg)
        if kind == "batch_results":
            res = c.messages.batches.results(arg)
            if inspect.isawaitable(res):
                res = await res
            if hasattr(res, "__aiter__"):
                return [r async for r in res]
            return list(res)
        raise RuntimeError(f"unknown effect {kind}")

    def _drive(self, gen: Gen) -> Any:
        value, exc = None, None
        while True:
            try:
                eff = gen.throw(exc) if exc is not None else gen.send(value)
            except StopIteration as stop:
                return stop.value
            value, exc = None, None
            try:
                value = self._exec_sync(eff)
            except Exception as e:  # thrown back into the generator
                exc = e

    async def _adrive(self, gen: Gen) -> Any:
        value, exc = None, None
        while True:
            try:
                eff = gen.throw(exc) if exc is not None else gen.send(value)
            except StopIteration as stop:
                return stop.value
            value, exc = None, None
            try:
                value = await self._exec_async(eff)
            except Exception as e:
                exc = e

    # ---- logging --------------------------------------------------------------------------------
    def _line(self, *, task_id: str, pipeline: str, step: int | None, requested_model: str | None,
              served_model: str | None, effort: str | None, tokens: dict[str, int] | None, cost: float,
              latency_ms: int, passed: bool, reason: str | None, escalated: bool, final: bool, batch: bool,
              role: str, stop_reason: str | None, retries: int, model_mismatch: bool,
              extra: dict[str, Any] | None, adaptations: list[str], status: str | None = None) -> dict[str, Any]:
        t = tokens or {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
        extra = extra or {}
        line: dict[str, Any] = {
            "timestamp": utc_timestamp(), "task_id": task_id, "pipeline": pipeline, "step": step,
            "requested_model": requested_model, "served_model": served_model, "effort": effort,
            "input_tokens": t["input_tokens"], "output_tokens": t["output_tokens"],
            "cache_read_tokens": t["cache_read_tokens"], "cache_write_tokens": t["cache_write_tokens"],
            "cost_usd": round(cost, 6), "latency_ms": int(latency_ms), "validation_passed": bool(passed),
            "validation_reason": reason, "escalated": bool(escalated), "final": bool(final), "batch": bool(batch),
            "role": role,
        }
        if status is not None:
            line["status"] = status
        line["stop_reason"] = stop_reason
        line["retries"] = int(retries)
        line["model_mismatch"] = bool(model_mismatch)
        line["human_rejected"] = bool(extra.get("human_rejected", False))
        if extra.get("rejected_task_id"):
            line["rejected_task_id"] = extra["rejected_task_id"]
        line["adaptations"] = list(adaptations)
        line["lang"] = self.lang
        return line

    def _check_spend(self) -> None:
        cap = spend_cap()
        if cap is None:
            return
        total = float(self.sink.total_spend())
        if total >= cap:
            raise SpendCapExceeded(total, cap)

    def _save_payload(self, task_id: str, pipeline: str, params: dict[str, Any]) -> None:
        self.sink.save_payload(task_id, {"task_id": task_id, "pipeline": pipeline, "lang": self.lang,
                                         "created": utc_timestamp(), "params": original_params(params)})

    # ---- send with infra retry ------------------------------------------------------------------
    def _send(self, effect: tuple[str, Any], fail_lines: list[dict[str, Any]], task_id: str | None) -> Gen:
        """Yields `effect` with same-model infra retry. Returns (value, retries, latency_ms).
        On exhaustion / non-retryable: writes each of `fail_lines` (templates) and raises."""
        retry = self.config.retry_cfg
        n = 0
        while True:
            self._check_spend()
            t0 = time.perf_counter()
            try:
                value = yield effect
                return value, n, int((time.perf_counter() - t0) * 1000)
            except Exception as exc:
                info = classify_error(exc)
                if info is None:
                    raise
                retryable, code, retry_after = info
                if retryable and n < int(retry["max_retries"]):
                    delay = backoff_seconds(n, retry, retry_after)
                    n += 1
                    yield ("sleep", delay)
                    continue
                reason = f"infra:{code}" if retryable else f"http_{code}"
                for tpl in fail_lines:
                    self.sink.write_line(self._line(**{**tpl, "reason": reason, "retries": n,
                                                       "status": "infra_error" if retryable else "request_error",
                                                       "final": True, "passed": False, "escalated": False,
                                                       "latency_ms": int((time.perf_counter() - t0) * 1000)}))
                if retryable:
                    raise RouterInfraError(f"infra failure after {n} retries: {code}", task_id=task_id,
                                           code=code, retries=n, cause=exc) from exc
                raise RouterRequestError(f"request rejected by API: HTTP {code}", task_id=task_id,
                                         status_code=int(code), cause=exc) from exc

    def _fail_template(self, task_id: str, pipeline: str, step: Step, adaptations: list[str],
                       extra: dict[str, Any] | None, batch: bool) -> dict[str, Any]:
        return dict(task_id=task_id, pipeline=pipeline, step=step.number, requested_model=step.model,
                    served_model=None, effort=self._sent_effort(step), tokens=None, cost=0.0, latency_ms=0,
                    passed=False, reason=None, escalated=False, final=True, batch=batch, role="attempt",
                    stop_reason=None, retries=0, model_mismatch=False, extra=extra, adaptations=adaptations)

    def _sent_effort(self, step: Step) -> str | None:
        return None if self.config.is_haiku(step.model) else step.effort

    # ---- evaluation (+ optional grader) ---------------------------------------------------------
    def _grader_applies(self, pcfg: dict[str, Any]) -> bool:
        g = pcfg.get("grader") or {}
        if not g.get("enabled"):
            return False
        return not any(is_deterministic(v, self.registry) for v in pcfg.get("validators") or [])

    def _evaluate(self, pcfg: dict[str, Any], pipeline: str, task_id: str, step: Step, message: Any,
                  params: dict[str, Any], extra: dict[str, Any] | None) -> Gen:
        """Returns (Evaluation, grader_cost_usd)."""
        ev = evaluate(message, pcfg.get("validators") or [], step.number, self.registry)
        if not ev.passed or not self._grader_applies(pcfg):
            return ev, 0.0
        g = pcfg.get("grader") or {}
        threshold = self.config.grader_threshold(pcfg)
        grader_model, _ = self.config.resolve_model("grader")
        gparams = {"max_tokens": 1024, "system": GRADER_SYSTEM_PROMPT, "messages": [{"role": "user", "content": (
            f"RUBRIC:\n{g.get('rubric', '')}\n\nORIGINAL REQUEST:\n{_user_text(params)}\n\n"
            f"CANDIDATE RESPONSE:\n{ev.text}")}]}
        sent, adaptations = adapt_request(self.config, gparams, grader_model, None)
        kwargs = to_sdk_kwargs(sent, None, self.request_timeout)
        try:
            gmsg, retries, latency = yield from self._send(("call", kwargs), [], task_id)
        except (RouterInfraError, RouterRequestError) as exc:
            code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
            ev.reason = "; ".join([f"grader_error:infra_{code}"] + ev.notes)
            return ev, 0.0
        served = _attr(gmsg, "model")
        tokens = usage_tokens(_attr(gmsg, "usage"))
        gcost, notes = compute_cost(self.config, served, grader_model, tokens, batch=False)
        gtext = "\n".join(_attr(b, "text", "") or "" for b in (_attr(gmsg, "content") or [])
                          if _attr(b, "type") == "text").strip()
        score: float | None = None
        try:
            obj = parse_json_text(gtext, "object")
            s = obj.get("score") if isinstance(obj, dict) else None
            if isinstance(s, (int, float)) and not isinstance(s, bool) and 0 <= s <= 10:
                score = float(s)
        except (ValueError, AttributeError):
            score = None
        gpass = score is not None and score >= threshold
        greason = f"grader:{_fmt_num(score)}" if score is not None else "grader_parse"
        self.sink.write_line(self._line(
            task_id=task_id, pipeline=pipeline, step=step.number, requested_model=grader_model,
            served_model=served, effort=None, tokens=tokens, cost=gcost, latency_ms=latency, passed=gpass,
            reason=greason, escalated=False, final=False, batch=False, role="grader",
            stop_reason=_attr(gmsg, "stop_reason"), retries=retries,
            model_mismatch=served is not None and served != grader_model, extra=extra,
            adaptations=adaptations + notes))
        if score is None:
            ev.reason = "; ".join(["grader_error:parse"] + ev.notes)
            return ev, gcost
        if score < threshold:
            ev.passed = False
            ev.reason = "; ".join([f"grader:{_fmt_num(score)}"] + ev.notes)
            ev.score = score / 10.0
        return ev, gcost

    def _record_attempt(self, *, task_id: str, pipeline: str, step: Step, message: Any, ev: Evaluation,
                        adaptations: list[str], retries: int, latency_ms: int, batch: bool, is_last: bool,
                        extra: dict[str, Any] | None, status_if_pass: str) -> tuple[Attempt, dict[str, Any]]:
        served = _attr(message, "model")
        tokens = usage_tokens(_attr(message, "usage"))
        if message is not None:
            cost, notes = compute_cost(self.config, served, step.model, tokens, batch)
        else:
            cost, notes = 0.0, []
        final = ev.passed or is_last
        status = (status_if_pass if ev.passed else "failed_all") if final else None
        line = self._line(
            task_id=task_id, pipeline=pipeline, step=step.number, requested_model=step.model, served_model=served,
            effort=self._sent_effort(step), tokens=tokens, cost=cost, latency_ms=latency_ms, passed=ev.passed,
            reason=ev.reason, escalated=(not ev.passed and not is_last), final=final, batch=batch,
            role="attempt", stop_reason=_attr(message, "stop_reason"), retries=retries,
            model_mismatch=served is not None and served != step.model, extra=extra,
            adaptations=adaptations + notes, status=status)
        att = Attempt(step=step.number, model=step.model, effort=self._sent_effort(step), passed=ev.passed,
                      reason=ev.reason, cost_usd=round(cost, 6), served_model=served, score=ev.score,
                      message=message, output=ev.output, text=ev.text)
        return att, line

    @staticmethod
    def _result(task_id: str, attempts: list[Attempt], total: float, first_step: int) -> RouteResult:
        winner = next((a for a in attempts if a.passed), None)
        if winner is not None:
            status = "passed" if winner.step == first_step else "escalated_passed"
            best = winner
        else:
            status = "failed_all"
            best = max(attempts, key=lambda a: (a.score, a.step))  # ties -> later step
        return RouteResult(status=status, task_id=task_id, final_step=best.step, message=best.message,
                           output=best.output, text=best.text, served_model=best.served_model,
                           total_cost_usd=round(total, 6), attempts=attempts)

    # ---- sync/async shared loop -----------------------------------------------------------------
    def _route_gen(self, pipeline: str, params: dict[str, Any], *, critical: bool | None = None,
                   task_id: str | None = None, headers: dict[str, str] | None = None, start_index: int = 0,
                   extra: dict[str, Any] | None = None) -> Gen:
        pcfg = self.config.pipeline(pipeline)
        ladder = self.config.effective_ladder(pcfg, critical)
        check_prefill(params)
        task_id = task_id or new_task_id(pipeline)
        self._save_payload(task_id, pipeline, params)
        steps = ladder[start_index:]
        attempts: list[Attempt] = []
        total = 0.0
        for step in steps:
            is_last = step is steps[-1]
            sent, adaptations = adapt_request(self.config, params, step.model, step.effort)
            kwargs = to_sdk_kwargs(sent, headers, self.request_timeout)
            tpl = self._fail_template(task_id, pipeline, step, adaptations, extra, batch=False)
            message, retries, latency = yield from self._send(("call", kwargs), [tpl], task_id)
            ev, gcost = yield from self._evaluate(pcfg, pipeline, task_id, step, message, params, extra)
            att, line = self._record_attempt(
                task_id=task_id, pipeline=pipeline, step=step, message=message, ev=ev, adaptations=adaptations,
                retries=retries, latency_ms=latency, batch=False, is_last=is_last, extra=extra,
                status_if_pass="passed" if step is steps[0] else "escalated_passed")
            self.sink.write_line(line)
            attempts.append(att)
            total += att.cost_usd + gcost
            if ev.passed:
                break
        return self._result(task_id, attempts, total, steps[0].number)

    def _batch_gen(self, pipeline: str, items: list[dict[str, Any]], *, critical: bool | None = None,
                   headers: dict[str, str] | None = None, poll_seconds: float | None = None) -> Gen:
        pcfg = self.config.pipeline(pipeline)
        if not pcfg.get("batchable"):
            raise RouterConfigError(f"pipeline '{pipeline}' is not batchable")
        ladder = self.config.effective_ladder(pcfg, critical)
        poll = self.config.batch_poll_seconds if poll_seconds is None else poll_seconds
        states: list[dict[str, Any]] = []
        seen: set[str] = set()
        for it in items:
            params = it["params"]
            check_prefill(params)
            tid = new_task_id(pipeline)
            cid = it.get("custom_id") or custom_id_for(tid)
            if not CUSTOM_ID_RE.match(cid) or cid in seen:
                raise RouterConfigError(f"invalid or duplicate custom_id '{cid}'")
            seen.add(cid)
            states.append({"task_id": tid, "custom_id": cid, "params": params, "attempts": [], "cost": 0.0,
                           "done": False})
        for st in states:
            self._save_payload(st["task_id"], pipeline, st["params"])

        pending = list(range(len(states)))
        for step in ladder:
            if not pending:
                break
            is_last = step is ladder[-1]
            requests, adapt_by, tpls = [], {}, []
            for i in pending:
                st = states[i]
                sent, adaptations = adapt_request(self.config, st["params"], step.model, step.effort)
                requests.append({"custom_id": st["custom_id"], "params": sent})
                adapt_by[i] = adaptations
                tpls.append(self._fail_template(st["task_id"], pipeline, step, adaptations, None, batch=True))
            t0 = time.perf_counter()
            batch, r1, _ = yield from self._send(("batch_create", requests), tpls, None)
            batch_id = _attr(batch, "id")
            retries = r1
            while _attr(batch, "processing_status") != "ended":
                yield ("sleep", poll)
                batch, rn, _ = yield from self._send(("batch_retrieve", batch_id), tpls, None)
                retries += rn
            results, rr, _ = yield from self._send(("batch_results", batch_id), tpls, None)
            retries += rr
            latency = int((time.perf_counter() - t0) * 1000)
            by_id = {_attr(r, "custom_id"): r for r in results}
            still: list[int] = []
            for i in pending:
                st = states[i]
                r = by_id.get(st["custom_id"])
                res = _attr(r, "result")
                rtype = _attr(res, "type") if r is not None else "missing"
                message = _attr(res, "message") if rtype == "succeeded" else None
                if message is not None:
                    ev, gcost = yield from self._evaluate(pcfg, pipeline, st["task_id"], step, message,
                                                          st["params"], None)
                else:
                    ev, gcost = Evaluation(False, f"batch:{rtype}", None, "", 0.0), 0.0
                att, line = self._record_attempt(
                    task_id=st["task_id"], pipeline=pipeline, step=step, message=message, ev=ev,
                    adaptations=adapt_by[i], retries=retries, latency_ms=latency, batch=True, is_last=is_last,
                    extra=None, status_if_pass="passed" if step is ladder[0] else "escalated_passed")
                self.sink.write_line(line)
                st["attempts"].append(att)
                st["cost"] += att.cost_usd + gcost
                if not ev.passed:
                    still.append(i)
            pending = still
        return [self._result(st["task_id"], st["attempts"], st["cost"], ladder[0].number) for st in states]


# ---------------------------------------------------------------------------------------------------
# Module-level convenience (lazy default router: routing.json + FileSink + env API key)
# ---------------------------------------------------------------------------------------------------
_default_router: Router | None = None


def default_router() -> Router:
    global _default_router
    if _default_router is None:
        _default_router = Router()
    return _default_router


def route(pipeline: str, params: dict[str, Any], **kw: Any) -> RouteResult:
    return default_router().route(pipeline, params, **kw)


async def aroute(pipeline: str, params: dict[str, Any], **kw: Any) -> RouteResult:
    return await default_router().aroute(pipeline, params, **kw)


def route_batch(pipeline: str, items: list[dict[str, Any]], **kw: Any) -> list[RouteResult]:
    return default_router().route_batch(pipeline, items, **kw)


async def aroute_batch(pipeline: str, items: list[dict[str, Any]], **kw: Any) -> list[RouteResult]:
    return await default_router().aroute_batch(pipeline, items, **kw)
