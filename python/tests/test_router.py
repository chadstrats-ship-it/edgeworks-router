"""Routing loop, retries, adaptation, grader, payload, spend cap, batch, reject. All mocked."""
from __future__ import annotations

import copy
import json

import pytest

from conftest import (HAIKU, OPUS, PARAMS, SONNET, AsyncFakeClient, attempt_lines, build_config, read_lines,
                      status_error, text_msg)
from edgeworks_router import (FileSink, PrefillNotSupported, Router, RouterInfraError, RouterRequestError,
                              SpendCapExceeded)
from edgeworks_router import cli
from edgeworks_router.cost import compute_cost, usage_tokens
from edgeworks_router.schema import sanitize_strict_schema


# --------------------------------------------------------------------------------------------- basic ladder

def test_pass_at_step_1(make_router, home):
    r, c = make_router([text_msg('{"ok": true}')])
    res = r.route("t-json", PARAMS)
    assert res.status == "passed" and res.final_step == 1
    assert res.output == {"ok": True}
    assert c.models_called == [SONNET]
    assert c.messages.calls[0]["params"]["output_config"] == {"effort": "high"}
    [line] = read_lines(home)
    assert line["validation_passed"] is True and line["final"] is True and line["escalated"] is False
    assert line["status"] == "passed" and line["lang"] == "py" and line["validation_reason"] is None


def test_schema_fail_at_step_1_then_pass_on_opus(make_router, home):
    r, c = make_router([text_msg('{"n": -1}'), text_msg('{"n": 3}', model=OPUS)])
    res = r.route("t-schema", PARAMS)
    assert res.status == "escalated_passed" and res.final_step == 2 and res.output == {"n": 3}
    assert c.models_called == [SONNET, OPUS]
    assert c.messages.calls[1]["params"]["output_config"] == {"effort": "medium"}
    l1, l2 = read_lines(home)
    assert l1["validation_reason"] == "schema:/n:minimum" and l1["escalated"] is True and l1["final"] is False
    assert l2["validation_passed"] is True and l2["final"] is True and l2["status"] == "escalated_passed"
    assert "status" not in l1


def test_max_tokens_escalates(make_router, home):
    r, c = make_router([text_msg("partial", stop="max_tokens"), text_msg("done", model=OPUS)])
    res = r.route("t-none", PARAMS)
    assert res.status == "escalated_passed" and c.models_called == [SONNET, OPUS]
    assert read_lines(home)[0]["validation_reason"] == "stop_reason:max_tokens"


def test_refusal_escalates(make_router, home):
    r, c = make_router([text_msg("", stop="refusal"), text_msg("ok", model=OPUS)])
    res = r.route("t-none", PARAMS)
    assert res.status == "escalated_passed" and c.models_called == [SONNET, OPUS]
    l1 = read_lines(home)[0]
    assert l1["validation_reason"] == "stop_reason:refusal" and l1["stop_reason"] == "refusal"


def test_all_steps_fail_returns_failed_all_with_best_attempt(make_router, home):
    # step1 passes json but misses field (score 0.5); step2 fails json (score 0) -> best = step 1
    r, _ = make_router([text_msg('{"nope": 1}'), text_msg("garbage", model=OPUS)])
    res = r.route("t-json", PARAMS)
    assert res.status == "failed_all" and res.final_step == 1
    assert res.output == {"nope": 1} and res.served_model == SONNET
    assert [a.passed for a in res.attempts] == [False, False]
    l1, l2 = read_lines(home)
    assert l2["final"] is True and l2["status"] == "failed_all" and l2["escalated"] is False
    assert res.total_cost_usd == round(l1["cost_usd"] + l2["cost_usd"], 6)


def test_all_fail_tie_prefers_later_step(make_router):
    r, _ = make_router([text_msg("x", stop="max_tokens"), text_msg("y", model=OPUS, stop="max_tokens")])
    res = r.route("t-none", PARAMS)
    assert res.status == "failed_all" and res.final_step == 2


def test_critical_flag_enables_step_3_opus_xhigh(make_router, home):
    script = [text_msg("a", stop="max_tokens"), text_msg("b", model=OPUS, stop="max_tokens"),
              text_msg("c", model=OPUS)]
    r, c = make_router(script)
    res = r.route("t-critical", PARAMS)
    assert res.status == "escalated_passed" and res.final_step == 3
    assert c.models_called == [SONNET, OPUS, OPUS]
    assert c.messages.calls[2]["params"]["output_config"] == {"effort": "xhigh"}
    assert [l["effort"] for l in read_lines(home)] == ["high", "medium", "xhigh"]


def test_non_critical_stops_at_step_2(make_router, home):
    r, c = make_router([text_msg("a", stop="max_tokens"), text_msg("b", model=OPUS, stop="max_tokens")])
    res = r.route("t-none", PARAMS)
    assert res.status == "failed_all"
    assert c.models_called == [SONNET, OPUS]  # no third call (script would raise if attempted)
    assert read_lines(home)[-1]["step"] == 2 and read_lines(home)[-1]["final"] is True


def test_smoke_force_escalation_builtin_custom_validator(make_router, home):
    r, c = make_router([text_msg("x"), text_msg("y", model=OPUS)])
    res = r.route("smoke-force-escalation", PARAMS)
    assert res.status == "escalated_passed" and c.models_called == [SONNET, OPUS]
    assert read_lines(home)[0]["validation_reason"] == "custom:fail_on_step_1:step_1"


def test_unregistered_custom_validator_does_not_fail(make_router, home):
    r, _ = make_router([text_msg("x")], extra={"t-cust": {"validators": [{"type": "custom", "name": "ts_only"}]}})
    res = r.route("t-cust", PARAMS)
    assert res.status == "passed"
    assert read_lines(home)[0]["validation_reason"] == "custom:ts_only:unavailable"


# --------------------------------------------------------------------------------------------- infra retry

def test_529_retries_same_model_and_does_not_escalate(make_router, home, sleeps):
    r, c = make_router([status_error(529), status_error(529), text_msg('{"ok":1}')])
    res = r.route("t-json", PARAMS)
    assert res.status == "passed" and res.final_step == 1
    assert c.models_called == [SONNET, SONNET, SONNET]
    assert sleeps == [1.0, 2.0]  # min(30000, 1000*2^n) * 1.0 jitter
    [line] = read_lines(home)
    assert line["retries"] == 2 and line["step"] == 1


def test_429_retry_after_header_honored(make_router, sleeps):
    r, c = make_router([status_error(429, {"retry-after": "45"}), status_error(429, {"retry-after": "0"}),
                        text_msg('{"ok":1}')])
    r.route("t-json", PARAMS)
    assert c.models_called == [SONNET] * 3
    assert sleeps == [45.0, 2.0]  # larger header wins; smaller header does not shorten backoff


def test_retries_exhausted_raises_infra_error_without_escalation(make_router, home, sleeps):
    r, c = make_router([status_error(529)] * 5)
    with pytest.raises(RouterInfraError) as ei:
        r.route("t-json", PARAMS)
    assert ei.value.code == "529" and ei.value.retries == 4
    assert c.models_called == [SONNET] * 5  # 1 + max_retries, never opus
    assert sleeps == [1.0, 2.0, 4.0, 8.0]
    [line] = read_lines(home)
    assert line["validation_reason"] == "infra:529" and line["final"] is True
    assert line["input_tokens"] == 0 and line["output_tokens"] == 0 and line["cost_usd"] == 0
    assert line["escalated"] is False and line["requested_model"] == SONNET


def test_network_and_timeout_errors_are_retried(make_router):
    import anthropic
    import httpx2
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    r, c = make_router([anthropic.APITimeoutError(request=req), anthropic.APIConnectionError(request=req),
                        text_msg("ok")])
    assert r.route("t-none", PARAMS).status == "passed"
    assert c.models_called == [SONNET] * 3


def test_non_retryable_400_raises_request_error(make_router, home, sleeps):
    r, c = make_router([status_error(400)])
    with pytest.raises(RouterRequestError) as ei:
        r.route("t-json", PARAMS)
    assert ei.value.status_code == 400
    assert c.models_called == [SONNET] and sleeps == []
    [line] = read_lines(home)
    assert line["validation_reason"] == "http_400" and line["final"] is True and line["escalated"] is False


# --------------------------------------------------------------------------------------------- logging/cost

def test_served_model_mismatch_logged(make_router, home):
    r, _ = make_router([text_msg("hi", model="claude-sonnet-5", inp=1_000_000, out=0)])
    res = r.route("t-none", PARAMS)
    [line] = read_lines(home)
    assert line["requested_model"] == SONNET and line["served_model"] == "claude-sonnet-5"
    assert line["model_mismatch"] is True and line["cost_usd"] == 2.0
    assert res.served_model == "claude-sonnet-5"


def test_unknown_served_model_priced_at_requested_alias(make_router, home):
    r, _ = make_router([text_msg("hi", model="claude-mystery-9", inp=1_000_000, out=0)])
    r.route("t-none", PARAMS)
    [line] = read_lines(home)
    assert line["cost_usd"] == 2.0 and "pricing_fallback" in line["adaptations"]


def test_cost_math_to_the_cent_incl_cache_and_batch_discount(make_router, home):
    cfg = build_config()
    usage = {"input_tokens": 1234, "output_tokens": 5678, "cache_creation_input_tokens": 9000,
             "cache_read_input_tokens": 100_000}
    t = usage_tokens(usage)
    # sonnet: 1234*2 + 5678*10 + 9000*2.5 + 100000*0.2 = 2468 + 56780 + 22500 + 20000 = 101748 -> $0.101748
    assert compute_cost(cfg, SONNET, SONNET, t, False) == (0.101748, [])
    # opus: 1234*4 + 5678*20 + 9000*5 + 100000*0.2 = 4936 + 113560 + 45000 + 20000 = 183496 -> $0.183496
    assert compute_cost(cfg, OPUS, OPUS, t, False) == (0.183496, [])
    # haiku: 1234*1 + 5678*5 + 9000*1.25 + 100000*0.1 = 1234 + 28390 + 11250 + 10000 = 50874 -> $0.050874
    assert compute_cost(cfg, HAIKU, HAIKU, t, False) == (0.050874, [])
    # batch discount (0.5) stacks with caching
    assert compute_cost(cfg, SONNET, SONNET, t, True) == (0.050874, [])
    assert compute_cost(cfg, OPUS, OPUS, t, True) == (0.091748, [])
    # through the live path (sync) with cache tokens
    r, _ = make_router([{"model": SONNET, "stop_reason": "end_turn", "content": [{"type": "text", "text": "x"}],
                         "usage": usage}])
    res = r.route("t-none", PARAMS)
    [line] = read_lines(home)
    assert line["cost_usd"] == 0.101748 and res.total_cost_usd == 0.101748
    assert line["cache_read_tokens"] == 100_000 and line["cache_write_tokens"] == 9000
    # through the batch path: discounted
    rb, _ = make_router(batch_handler=lambda n, reqs: {q["custom_id"]: {
        "model": SONNET, "stop_reason": "end_turn", "content": [{"type": "text", "text": "x"}], "usage": usage}
        for q in reqs})
    [bres] = rb.route_batch("t-batch-none", [{"params": PARAMS}])
    bline = [l for l in read_lines(home) if l["batch"]][0]
    assert bline["cost_usd"] == 0.050874 and bres.total_cost_usd == 0.050874


def test_payload_file_written_and_contains_no_api_key(make_router, home):
    key = "fake-test-key-DO-NOT-LEAK-0123456789"
    params = {**PARAMS, "model": "caller-model-ignored"}
    r, c = make_router([text_msg("ok")])
    res = r.route("t-none", params, headers={"x-api-key": key, "anthropic-beta": "some-beta"})
    p = home / "logs" / "payloads" / f"{res.task_id}.json"
    assert p.is_file()
    payload = json.loads(p.read_text(encoding="utf-8"))
    assert set(payload) == {"task_id", "pipeline", "lang", "created", "params"}
    assert payload["pipeline"] == "t-none" and payload["lang"] == "py"
    assert "model" not in payload["params"] and payload["params"] == PARAMS
    for f in (home / "logs").rglob("*"):
        if f.is_file():
            assert key not in f.read_text(encoding="utf-8")
    # call-site headers are forwarded verbatim (beta header only because the call site passed it)
    assert c.messages.calls[0]["headers"] == {"x-api-key": key, "anthropic-beta": "some-beta"}
    assert res.task_id.startswith("t-none-")


def test_task_id_format(make_router):
    import re
    r, _ = make_router([text_msg("ok")])
    res = r.route("t-none", PARAMS)
    assert re.fullmatch(r"t-none-\d{14}-[0-9a-f]{8}", res.task_id)


def test_spend_cap_raises_spend_cap_exceeded(make_router, home, monkeypatch):
    logs = home / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    (logs / "router-2026-09.jsonl").write_text(json.dumps({"cost_usd": 2.5}) + "\n" + json.dumps({"cost_usd": 0.6})
                                               + "\n", encoding="utf-8")
    monkeypatch.setenv("EDGEWORKS_ROUTER_SPEND_CAP_USD", "3")
    r, c = make_router([text_msg("ok")])
    with pytest.raises(SpendCapExceeded) as ei:
        r.route("t-none", PARAMS)
    assert ei.value.total == pytest.approx(3.1) and ei.value.cap == 3.0
    assert c.models_called == []


def test_spend_cap_below_cap_allows_and_cache_is_incremental(make_router, home, monkeypatch):
    monkeypatch.setenv("EDGEWORKS_ROUTER_SPEND_CAP_USD", "3")
    r, _ = make_router([text_msg("ok", inp=1_000_000, out=0), text_msg("ok", inp=1_000_000, out=0)])
    r.route("t-none", PARAMS)          # +$2.00
    assert r.sink.total_spend() == 2.0
    r.route("t-none", PARAMS)          # spend 2.0 < 3 -> allowed, now 4.0
    assert r.sink.total_spend() == 4.0
    with pytest.raises(SpendCapExceeded):
        r.route("t-none", PARAMS)


def test_prefill_raises_before_send(make_router, home):
    r, c = make_router([text_msg("ok")])
    params = {"max_tokens": 10, "messages": [{"role": "user", "content": "x"}, {"role": "assistant", "content": "{"}]}
    with pytest.raises(PrefillNotSupported):
        r.route("t-none", params)
    assert c.models_called == [] and read_lines(home) == []


# --------------------------------------------------------------------------------------------- adaptation

def test_forced_tool_choice_adapted_to_auto_strict_and_temperature_removed(make_router, home):
    schema = {"type": "object", "properties": {
        "a": {"type": "string", "minLength": 5, "pattern": "^(?=x).*$", "format": "phone"},
        "n": {"type": "integer", "minimum": 1, "maximum": 9},
        "tags": {"type": "array", "items": {"type": "object", "properties": {"k": {"type": "string"}}},
                 "minItems": 2, "maxItems": 4},
        "d": {"type": "string", "format": "date", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}},
        "required": ["a"]}
    params = {"max_tokens": 100, "messages": [{"role": "user", "content": "x"}],
              "tools": [{"name": "t", "input_schema": schema}, {"name": "other", "input_schema": {"type": "object"}}],
              "tool_choice": {"type": "tool", "name": "t"}, "temperature": 0.2, "top_k": 5, "top_p": 0.5,
              "thinking": {"type": "enabled", "budget_tokens": 2000}}
    original = copy.deepcopy(params)
    tool_resp = {"model": SONNET, "stop_reason": "tool_use",
                 "content": [{"type": "tool_use", "id": "tu1", "name": "t", "input": {"a": "xy"}}],
                 "usage": {"input_tokens": 1, "output_tokens": 1}}
    tool_ok = {**tool_resp, "model": OPUS, "content": [{"type": "tool_use", "id": "tu2", "name": "t",
                                                        "input": {"a": "xlonger"}}]}
    extra = {"t-tool": {"validators": [{"type": "tool_use", "name": "t"},
                                       {"type": "json_schema", "schema": schema}]}}
    r, c = make_router([tool_resp, tool_ok], extra=extra)
    res = r.route("t-tool", params)
    sent = c.messages.calls[0]["params"]
    assert sent["tool_choice"] == {"type": "auto"}
    assert sent["tools"][0]["strict"] is True and "strict" not in sent["tools"][1]
    s = sent["tools"][0]["input_schema"]
    assert s["additionalProperties"] is False
    assert s["properties"]["tags"]["items"]["additionalProperties"] is False
    assert s["properties"]["a"] == {"type": "string"}                      # minLength, lookahead pattern, format
    assert s["properties"]["n"] == {"type": "integer"}                     # minimum, maximum
    assert "minItems" not in s["properties"]["tags"] and "maxItems" not in s["properties"]["tags"]
    assert s["properties"]["d"] == {"type": "string", "format": "date", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}
    for k in ("temperature", "top_k", "top_p"):
        assert k not in sent
    assert sent["thinking"] == {"type": "adaptive"} and sent["output_config"] == {"effort": "high"}
    assert params == original  # call-site params never mutated
    # ORIGINAL schema still enforced locally: "xy" violates minLength 5 -> escalates
    assert res.status == "escalated_passed" and res.output == {"a": "xlonger"}
    l1 = read_lines(home)[0]
    assert l1["validation_reason"] == "schema:/a:minLength"
    for a in ("forced_tool_use->auto_strict", "temperature_removed", "top_k_removed", "top_p_removed",
              "thinking_enabled->adaptive", "strict_strip:t/properties/a/minLength",
              "strict_strip:t/properties/a/pattern", "strict_strip:t/properties/a/format",
              "strict_strip:t/properties/n/minimum", "strict_strip:t/properties/tags/maxItems",
              "strict_strip:t/properties/tags/minItems"):
        assert a in l1["adaptations"], a
    payload = json.loads((home / "logs" / "payloads" / f"{res.task_id}.json").read_text(encoding="utf-8"))
    assert payload["params"]["tool_choice"] == {"type": "tool", "name": "t"} and payload["params"]["temperature"] == 0.2


def test_thinking_disabled_becomes_between_tools_and_temperature_1_kept(make_router):
    r, c = make_router([text_msg("ok")])
    r.route("t-none", {**PARAMS, "thinking": {"type": "disabled"}, "temperature": 1, "top_p": 0.995})
    sent = c.messages.calls[0]["params"]
    assert sent["thinking"] == {"type": "between_tools"}
    assert sent["temperature"] == 1 and sent["top_p"] == 0.995
    assert c.messages.calls[0]["raw_keys"] >= {"extra_body"}  # untyped SDK fields go via extra_body


def test_strict_schema_sanitizer_rules():
    s = {"type": "object", "additionalProperties": True, "minProperties": 1, "properties": {
        "x": {"type": "number", "multipleOf": 2, "exclusiveMinimum": 0},
        "y": {"type": "array", "minItems": 1, "uniqueItems": True, "items": {"type": "string", "maxLength": 3}},
        "z": {"anyOf": [{"type": "object", "properties": {}}, {"type": "null"}]},
        "w": {"type": "string", "pattern": "^(a)\\1$"}, "v": {"type": "string", "pattern": "^a{1,500}$"},
        "u": {"type": "string", "pattern": "^[a-z]{2,8}$"}},
        "$defs": {"D": {"type": "object", "properties": {"q": {"type": "integer", "maximum": 3}}}}}
    out, stripped = sanitize_strict_schema(s)
    assert s["additionalProperties"] is True and s["properties"]["x"]["multipleOf"] == 2  # original intact
    assert out["additionalProperties"] is False and "minProperties" not in out
    assert out["properties"]["x"] == {"type": "number"}
    assert out["properties"]["y"] == {"type": "array", "minItems": 1, "items": {"type": "string"}}
    assert out["properties"]["z"]["anyOf"][0]["additionalProperties"] is False
    assert "pattern" not in out["properties"]["w"] and "pattern" not in out["properties"]["v"]
    assert out["properties"]["u"]["pattern"] == "^[a-z]{2,8}$"
    assert out["$defs"]["D"]["properties"]["q"] == {"type": "integer"}
    assert out["$defs"]["D"]["additionalProperties"] is False
    assert "/additionalProperties" in stripped and "/$defs/D/properties/q/maximum" in stripped


# --------------------------------------------------------------------------------------------- grader

def test_grader_not_used_when_pipeline_has_deterministic_validators(make_router, home):
    r, c = make_router([text_msg('{"a":1}')])
    res = r.route("t-grader-det", PARAMS)
    assert res.status == "passed" and c.models_called == [SONNET]  # no haiku call
    assert all(l["role"] == "attempt" for l in read_lines(home))


def test_grader_used_for_free_text_and_below_threshold_escalates(make_router, home):
    script = [text_msg("rude answer"), text_msg('{"score": 4, "reason": "rude"}', model=HAIKU),
              text_msg("polite answer", model=OPUS), text_msg('{"score": 9, "reason": "good"}', model=HAIKU)]
    r, c = make_router(script)
    res = r.route("t-grader", PARAMS)
    assert c.models_called == [SONNET, HAIKU, OPUS, HAIKU]
    assert res.status == "escalated_passed" and res.text == "polite answer"
    grader_call = c.messages.calls[1]["params"]
    assert "output_config" not in grader_call  # never effort to Haiku
    assert "Must be polite." in grader_call["messages"][0]["content"]
    assert "rude answer" in grader_call["messages"][0]["content"]
    lines = read_lines(home)
    assert [l["role"] for l in lines] == ["grader", "attempt", "grader", "attempt"]
    assert lines[1]["validation_reason"] == "grader:4" and lines[1]["escalated"] is True
    assert lines[0]["cost_usd"] > 0 and lines[0]["requested_model"] == HAIKU and lines[0]["effort"] is None
    assert res.total_cost_usd == round(sum(l["cost_usd"] for l in lines), 6)


def test_grader_parse_error_passes_with_logged_reason(make_router, home):
    r, _ = make_router([text_msg("answer"), text_msg("I think it is fine", model=HAIKU)])
    res = r.route("t-grader", PARAMS)
    assert res.status == "passed"
    att = [l for l in read_lines(home) if l["role"] == "attempt"][0]
    assert att["validation_reason"] == "grader_error:parse" and att["validation_passed"] is True


def test_grader_infra_error_passes_with_logged_reason(make_router, home):
    r, _ = make_router([text_msg("answer"), status_error(400)])
    res = r.route("t-grader", PARAMS)
    assert res.status == "passed"
    att = read_lines(home)[-1]
    assert att["validation_reason"] == "grader_error:infra_400"


# --------------------------------------------------------------------------------------------- batch

def test_batch_resubmits_only_failures_on_opus(make_router, home):
    def handler(n, reqs):
        ids = [q["custom_id"] for q in reqs]
        if n == 1:
            return {"a": text_msg('{"ok":1}'), "b": text_msg("not json"), "c": "errored", "d": text_msg(
                '{"ok":2}')}
        return {cid: text_msg('{"ok":3}', model=OPUS) for cid in ids}
    r, c = make_router(batch_handler=handler)
    items = [{"custom_id": x, "params": {**PARAMS, "messages": [{"role": "user", "content": x}]}} for x in "abcd"]
    results = r.route_batch("t-batch", items)
    created = c.messages.batches.created
    assert len(created) == 2
    assert sorted(q["custom_id"] for q in created[0]) == ["a", "b", "c", "d"]
    assert sorted(q["custom_id"] for q in created[1]) == ["b", "c"]  # ONLY the failures
    assert all(q["params"]["model"] == OPUS and q["params"]["output_config"] == {"effort": "medium"}
               for q in created[1])
    assert all(q["params"]["model"] == SONNET for q in created[0])
    assert created[1][0]["params"]["messages"][0]["content"] in ("b", "c")
    assert [res.status for res in results] == ["passed", "escalated_passed", "escalated_passed", "passed"]
    assert results[1].output == {"ok": 3} and results[0].output == {"ok": 1}  # input order preserved
    lines = read_lines(home)
    assert len(lines) == 6 and all(l["batch"] is True for l in lines)
    reasons = {(l["task_id"], l["step"]): l["validation_reason"] for l in lines}
    assert reasons[(results[1].task_id, 1)] == "json_parse" and reasons[(results[2].task_id, 1)] == "batch:errored"
    assert c.models_called == []  # no synchronous calls
    for res in results:
        assert (home / "logs" / "payloads" / f"{res.task_id}.json").is_file()


def test_batch_all_fail_gives_failed_all(make_router):
    r, _ = make_router(batch_handler=lambda n, reqs: {q["custom_id"]: "expired" for q in reqs})
    [res] = r.route_batch("t-batch", [{"params": PARAMS}])
    assert res.status == "failed_all" and res.message is None and len(res.attempts) == 2


def test_batch_requires_batchable_pipeline(make_router):
    from edgeworks_router import RouterConfigError
    r, _ = make_router()
    with pytest.raises(RouterConfigError):
        r.route_batch("t-json", [{"params": PARAMS}])


def test_cli_batch_command(make_router, home, tmp_path, capsys):
    r, _ = make_router(batch_handler=lambda n, reqs: {q["custom_id"]: text_msg('{"ok":1}') for q in reqs})
    inp = tmp_path / "in.jsonl"
    inp.write_text("\n".join(json.dumps({"custom_id": f"i{i}", "params": PARAMS}) for i in range(3)), encoding="utf-8")
    out = tmp_path / "out.jsonl"
    assert cli.main(["batch", "t-batch", str(inp), "--out", str(out)], router=r) == 0
    rows = [json.loads(x) for x in out.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 3 and all(x["status"] == "passed" for x in rows)
    assert rows[0]["message"]["content"][0]["type"] == "text"


# --------------------------------------------------------------------------------------------- reject

def test_router_reject_reruns_from_opus_step_and_logs_human_rejected(make_router, home, capsys):
    r1, _ = make_router([text_msg('{"ok": true}')])
    first = r1.route("t-json", PARAMS)
    assert first.final_step == 1
    r2, c2 = make_router([text_msg('{"ok": "better"}', model=OPUS)])
    rc = cli.main(["reject", first.task_id, "--reason", "wrong tone"], router=r2)
    assert rc == 0
    assert c2.models_called == [OPUS]
    assert c2.messages.calls[0]["params"]["output_config"] == {"effort": "medium"}
    new_id = f"{first.task_id}-r1"
    lines = read_lines(home)
    rej = [l for l in lines if l["role"] == "rejection"]
    assert len(rej) == 1 and rej[0]["task_id"] == first.task_id and rej[0]["human_rejected"] is True
    assert rej[0]["validation_reason"] == "human_rejected: wrong tone" and rej[0]["cost_usd"] == 0
    rerun = [l for l in lines if l["task_id"] == new_id]
    assert len(rerun) == 1 and rerun[0]["step"] == 2 and rerun[0]["requested_model"] == OPUS
    assert rerun[0]["human_rejected"] is True and rerun[0]["rejected_task_id"] == first.task_id
    assert rerun[0]["status"] == "passed"
    saved = home / "logs" / "rejections" / f"{new_id}.json"
    assert saved.is_file() and json.loads(saved.read_text(encoding="utf-8"))["task_id"] == new_id
    printed = json.loads(capsys.readouterr().out)
    assert printed["task_id"] == new_id and printed["output"] == {"ok": "better"}
    # second rejection of the same task -> -r2
    r3, _ = make_router([text_msg('{"ok": 1}', model=OPUS)])
    assert r3.reject(first.task_id, "again").task_id == f"{first.task_id}-r2"


def test_reject_critical_pipeline_includes_step_3(make_router, home):
    r1, _ = make_router([text_msg("ok")])
    first = r1.route("t-critical", PARAMS)
    r2, c2 = make_router([text_msg("x", model=OPUS, stop="max_tokens"), text_msg("y", model=OPUS)])
    res = r2.reject(first.task_id, "nope")
    assert c2.models_called == [OPUS, OPUS] and res.final_step == 3 and res.status == "escalated_passed"


# --------------------------------------------------------------------------------------------- async + misc

async def test_aroute_async_pass_and_escalation(home):
    c = AsyncFakeClient([text_msg("nope"), text_msg('{"ok":1}', model=OPUS)])
    r = Router(build_config(), async_client=c, sink=FileSink(home))
    res = await r.aroute("t-json", PARAMS)
    assert res.status == "escalated_passed" and c.models_called == [SONNET, OPUS]
    assert len(attempt_lines(home)) == 2


async def test_aroute_async_retry_uses_async_sleep(home, sleeps):
    c = AsyncFakeClient([status_error(529), text_msg("ok")])
    r = Router(build_config(), async_client=c, sink=FileSink(home))
    res = await r.aroute("t-none", PARAMS)
    assert res.status == "passed" and sleeps == [1.0]


async def test_aroute_batch_async_resubmits_failures(home, sleeps):
    def handler(n, reqs):
        if n == 1:
            return {"a": text_msg('{"ok":1}'), "b": text_msg("bad")}
        return {q["custom_id"]: text_msg('{"ok":2}', model=OPUS) for q in reqs}
    c = AsyncFakeClient(batch_handler=handler)
    r = Router(build_config(), async_client=c, sink=FileSink(home))
    res = await r.aroute_batch("t-batch", [{"custom_id": "a", "params": PARAMS}, {"custom_id": "b", "params": PARAMS}])
    assert [x.status for x in res] == ["passed", "escalated_passed"]
    assert [q["custom_id"] for q in c.messages.batches.created[1]] == ["b"]
    assert sleeps == [30.0, 30.0]  # one poll per batch at batch_poll_seconds


def test_cli_spend(make_router, home, capsys):
    r, _ = make_router([text_msg("ok", inp=1_000_000, out=0)])
    r.route("t-none", PARAMS)
    assert cli.main(["spend"], router=r) == 0
    assert "total spend: $2.000000" in capsys.readouterr().out


def test_memory_and_noop_sinks(home):
    from conftest import FakeClient
    from edgeworks_router import MemorySink, NoopSink
    mem = MemorySink()
    r = Router(build_config(), client=FakeClient([text_msg("ok")]), sink=mem)
    res = r.route("t-none", PARAMS)
    assert len(mem.lines) == 1 and res.task_id in mem.payloads and mem.total_spend() == mem.lines[0]["cost_usd"]
    r2 = Router(build_config(), client=FakeClient([text_msg("ok")]), sink=NoopSink())
    assert r2.route("t-none", PARAMS).status == "passed"
    assert not (home / "logs").exists()  # nothing written anywhere


def test_module_level_route_uses_default_router(monkeypatch, home):
    import edgeworks_router.router as rm
    from conftest import FakeClient
    import edgeworks_router
    c = FakeClient([text_msg("ok")])
    monkeypatch.setattr(rm, "_default_router", Router(build_config(), client=c, sink=FileSink(home)))
    assert edgeworks_router.route("t-none", PARAMS).status == "passed" and c.models_called == [SONNET]
