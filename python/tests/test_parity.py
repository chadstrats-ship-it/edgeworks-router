"""Cross-language parity: every case in shared/fixtures/parity.json (spec §9)."""
from __future__ import annotations

import json
import re
from typing import Any

import pytest

from conftest import PARITY_JSON, attempt_lines

CASES = json.loads(PARITY_JSON.read_text(encoding="utf-8"))["cases"]
DEFAULT_REQUEST = {"max_tokens": 100, "messages": [{"role": "user", "content": "x"}]}
_ABSENT = object()


def _get_path(obj: Any, path: str) -> Any:
    """'tools[0].input_schema.additionalProperties' -> value, or _ABSENT."""
    cur = obj
    for part in path.split("."):
        m = re.fullmatch(r"([^\[]+)((?:\[\d+\])*)", part)
        key, idxs = m.group(1), re.findall(r"\[(\d+)\]", m.group(2))
        if not isinstance(cur, dict) or key not in cur:
            return _ABSENT
        cur = cur[key]
        for i in idxs:
            if not isinstance(cur, list) or int(i) >= len(cur):
                return _ABSENT
            cur = cur[int(i)]
    return cur


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_parity_case(case, make_router, home):
    extra = {"parity": {"validators": case["validators"], "batchable": bool(case.get("batch")), "critical": False,
                        "max_attempts": 3, "ladder": None}}
    request = case.get("request") or DEFAULT_REQUEST
    responses = list(case["responses"])
    if case.get("batch"):
        steps = iter(responses)
        r, client = make_router(extra=extra,
                                batch_handler=lambda n, reqs: {q["custom_id"]: next(steps) for q in reqs})
        [res] = r.route_batch("parity", [{"params": request}])
        sent_calls = [q["params"] for b in client.messages.batches.created for q in b]
    else:
        r, client = make_router(responses, extra=extra)
        res = r.route("parity", request)
        sent_calls = [c["params"] for c in client.messages.calls]
    exp = case["expect"]
    if "status" in exp:
        assert res.status == exp["status"]
    if "final_step" in exp:
        assert res.final_step == exp["final_step"]
    lines = attempt_lines(home)
    assert len(lines) >= len(exp["lines"])
    for i, want in enumerate(exp["lines"]):
        got = lines[i]
        for k, v in want.items():
            if k == "adaptations_include":
                for a in v:
                    assert a in got["adaptations"], (case["name"], i, a)
            elif k == "cost_usd":
                assert round(got["cost_usd"], 6) == round(v, 6), (case["name"], i, got["cost_usd"], v)
            else:
                assert got.get(k) == v, (case["name"], i, k, got.get(k), v)
    for path, v in (exp.get("sent_request") or {}).items():
        got = _get_path(sent_calls[0], path)
        if v == "<absent>":
            assert got is _ABSENT, (path, got)
        else:
            assert got == v, (path, got, v)
