"""Shared fixtures: fake Anthropic client (sync + async), temp HOME, patched sleep/jitter. NO live API calls."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import anthropic
import httpx2
import pytest
from anthropic.types import Message
from anthropic.types.messages import MessageBatchIndividualResponse

import edgeworks_router.router as router_mod
from edgeworks_router import FileSink, Router, RoutingConfig

ROOT = Path(__file__).resolve().parents[2]
ROUTING_JSON = ROOT / "routing.json"
PARITY_JSON = ROOT / "shared" / "fixtures" / "parity.json"

SONNET = "claude-sonnet-5-5"
OPUS = "claude-opus-5-5"
HAIKU = "claude-haiku-4-5-20251001"


def make_message(d: dict[str, Any]) -> Message:
    full = {"id": "msg_test", "type": "message", "role": "assistant", "stop_sequence": None,
            "model": SONNET, "stop_reason": "end_turn", "content": [], "usage": {"input_tokens": 0, "output_tokens": 0}}
    full.update(copy.deepcopy(d))
    return Message.model_validate(full)


def text_msg(text: str, model: str = SONNET, stop: str = "end_turn", inp: int = 10, out: int = 10,
             **usage: int) -> dict[str, Any]:
    return {"model": model, "stop_reason": stop, "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": inp, "output_tokens": out, **usage}}


def status_error(code: int, headers: dict[str, str] | None = None) -> anthropic.APIStatusError:
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    resp = httpx2.Response(code, headers=headers or {}, request=req)
    return anthropic.APIStatusError(f"HTTP {code}", response=resp, body=None)


class FakeBatches:
    """handler(step_no, requests) -> {custom_id: response-dict | ("errored"|"expired"|"canceled")}"""

    def __init__(self, handler: Callable[[int, list[dict[str, Any]]], dict[str, Any]] | None):
        self.handler = handler
        self.created: list[list[dict[str, Any]]] = []
        self._results: dict[str, list[Any]] = {}
        self._polls: dict[str, int] = {}

    def create(self, *, requests: list[dict[str, Any]], **_: Any) -> Any:
        self.created.append(copy.deepcopy(list(requests)))
        bid = f"msgbatch_{len(self.created)}"
        out = self.handler(len(self.created), list(requests))
        res = []
        for cid, r in reversed(list(out.items())):  # order NOT guaranteed -> reverse it
            if isinstance(r, str):
                body = {"type": r}
                if r == "errored":
                    body["error"] = {"type": "error", "error": {"type": "api_error", "message": "boom"}}
                res.append(MessageBatchIndividualResponse.model_validate({"custom_id": cid, "result": body}))
            else:
                full = make_message(r).model_dump(mode="json")
                res.append(MessageBatchIndividualResponse.model_validate(
                    {"custom_id": cid, "result": {"type": "succeeded", "message": full}}))
        self._results[bid] = res
        self._polls[bid] = 0
        return SimpleNamespace(id=bid, processing_status="in_progress")

    def retrieve(self, bid: str, **_: Any) -> Any:
        self._polls[bid] += 1
        return SimpleNamespace(id=bid, processing_status="ended" if self._polls[bid] >= 1 else "in_progress")

    def results(self, bid: str, **_: Any) -> Any:
        return iter(self._results[bid])


class FakeMessages:
    def __init__(self, script: list[Any], batch_handler: Any = None):
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []
        self.batches = FakeBatches(batch_handler)

    def create(self, **kw: Any) -> Message:
        merged = {k: v for k, v in kw.items() if k not in ("extra_body", "extra_headers", "timeout")}
        merged.update(kw.get("extra_body") or {})
        self.calls.append({"params": copy.deepcopy(merged), "headers": kw.get("extra_headers"), "raw_keys": set(kw)})
        if not self.script:
            raise AssertionError("fake client script exhausted (unexpected extra API call)")
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return make_message(item)


class FakeClient:
    def __init__(self, script: list[Any] | None = None, batch_handler: Any = None):
        self.messages = FakeMessages(script or [], batch_handler)

    @property
    def models_called(self) -> list[str]:
        return [c["params"]["model"] for c in self.messages.calls]


class AsyncFakeClient:
    """Mirrors AsyncAnthropic: awaitable create/batches.*; batches.results() awaits to an async iterator."""

    def __init__(self, script: list[Any] | None = None, batch_handler: Any = None):
        self._sync = FakeClient(script, batch_handler)
        outer = self

        class _AIter:
            def __init__(self, items: Any):
                self._it = iter(items)

            def __aiter__(self) -> "_AIter":
                return self

            async def __anext__(self) -> Any:
                try:
                    return next(self._it)
                except StopIteration:
                    raise StopAsyncIteration

        class _B:
            @property
            def created(self) -> list:
                return outer._sync.messages.batches.created

            async def create(self, **kw: Any) -> Any:
                return outer._sync.messages.batches.create(**kw)

            async def retrieve(self, bid: str, **kw: Any) -> Any:
                return outer._sync.messages.batches.retrieve(bid, **kw)

            async def results(self, bid: str, **kw: Any) -> Any:
                return _AIter(outer._sync.messages.batches.results(bid, **kw))

        class _M:
            batches = _B()

            async def create(self, **kw: Any) -> Message:
                return outer._sync.messages.create(**kw)
        self.messages = _M()

    @property
    def models_called(self) -> list[str]:
        return self._sync.models_called


TEST_PIPELINES: dict[str, Any] = {
    "t-json": {"validators": [{"type": "json"}, {"type": "required_fields", "fields": ["ok"]}]},
    "t-none": {"validators": []},
    "t-critical": {"validators": [], "critical": True},
    "t-schema": {"validators": [{"type": "json"}, {"type": "json_schema", "schema": {
        "type": "object", "properties": {"n": {"type": "integer", "minimum": 0}}, "required": ["n"]}}]},
    "t-grader": {"validators": [], "grader": {"enabled": True, "threshold": 7, "rubric": "Must be polite."}},
    "t-grader-det": {"validators": [{"type": "json"}],
                     "grader": {"enabled": True, "threshold": 7, "rubric": "x"}},
    "t-batch": {"validators": [{"type": "json"}, {"type": "required_fields", "fields": ["ok"]}], "batchable": True},
    "t-batch-none": {"validators": [], "batchable": True},
}


def build_config(extra: dict[str, Any] | None = None) -> RoutingConfig:
    data = json.loads(ROUTING_JSON.read_text(encoding="utf-8"))
    base = {"description": "test", "ladder": None, "validators": [],
            "grader": {"enabled": False, "threshold": 7, "rubric": ""}, "max_attempts": 3, "batchable": False,
            "critical": False, "pinned_model": None}
    for name, over in {**TEST_PIPELINES, **(extra or {})}.items():
        data["pipelines"][name] = {**base, **over}
    return RoutingConfig(data, ROUTING_JSON)


@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """HOME -> tmp dir (never the real logs), real routing.json, no spend cap, instant sleeps, max jitter."""
    monkeypatch.setenv("EDGEWORKS_ROUTER_HOME", str(tmp_path))
    monkeypatch.setenv("EDGEWORKS_ROUTING_JSON", str(ROUTING_JSON))
    monkeypatch.delenv("EDGEWORKS_ROUTER_SPEND_CAP_USD", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-test-key-DO-NOT-LEAK-0123456789")
    sleeps: list[float] = []

    def fake_sleep(s: float) -> None:
        sleeps.append(s)

    async def fake_asleep(s: float) -> None:
        sleeps.append(s)

    monkeypatch.setattr(router_mod, "_sleep", fake_sleep)
    monkeypatch.setattr(router_mod, "_asleep", fake_asleep)
    monkeypatch.setattr(router_mod, "_random", lambda: 1.0)
    return {"home": tmp_path, "sleeps": sleeps}


@pytest.fixture
def home(isolated_env: dict[str, Any]) -> Path:
    return isolated_env["home"]


@pytest.fixture
def sleeps(isolated_env: dict[str, Any]) -> list[float]:
    return isolated_env["sleeps"]


@pytest.fixture
def make_router(home: Path):
    def _make(script: list[Any] | None = None, *, batch_handler: Any = None, extra: dict[str, Any] | None = None,
              client: Any = None, **kw: Any) -> tuple[Router, Any]:
        c = client or FakeClient(script, batch_handler)
        return Router(build_config(extra), client=c, sink=FileSink(home), **kw), c
    return _make


def read_lines(home: Path) -> list[dict[str, Any]]:
    out = []
    for f in sorted((home / "logs").glob("router-*.jsonl")):
        for raw in f.read_text(encoding="utf-8").splitlines():
            if raw.strip():
                out.append(json.loads(raw))
    return out


def attempt_lines(home: Path) -> list[dict[str, Any]]:
    return [l for l in read_lines(home) if l["role"] == "attempt"]


PARAMS = {"max_tokens": 100, "messages": [{"role": "user", "content": "Return JSON {\"ok\": true}"}]}
