"""Cross-language parity driver: runs the REAL Python router (python/edgeworks_router) over unified cases with
the Python suite's own FakeClient + MemorySink, and prints {case: {lines, payloads, results, error}} as JSON.
Invoked by ts/test/xlang.test.ts. NO live API calls, no file sinks (MemorySink only).
usage: python xlang_dump.py <cases.json> <routing.json> <python_root>
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

cases_path, routing_path, py_root = sys.argv[1:4]
sys.path.insert(0, py_root)
sys.path.insert(0, str(Path(py_root) / "tests"))

import edgeworks_router.router as router_mod  # noqa: E402

router_mod._sleep = lambda s: None
router_mod._random = lambda: 0.5

from conftest import FakeClient, status_error  # noqa: E402
from edgeworks_router import Router  # noqa: E402
from edgeworks_router.errors import RouterError  # noqa: E402
from edgeworks_router.sinks import MemorySink  # noqa: E402

DEFAULT_REQUEST = {"max_tokens": 100, "messages": [{"role": "user", "content": "x"}]}
PIPE_DEFAULTS = {"description": "xlang", "ladder": None, "validators": [],
                 "grader": {"enabled": False, "threshold": 7, "rubric": ""}, "max_attempts": 3,
                 "batchable": False, "critical": False, "pinned_model": None}

base = json.loads(Path(routing_path).read_text(encoding="utf-8"))
out: dict = {}
for case in json.loads(Path(cases_path).read_text(encoding="utf-8")):
    data = copy.deepcopy(base)
    data["pipelines"] = {"p": {**PIPE_DEFAULTS, **case.get("pipeline", {})}}
    sink = MemorySink()
    script = [status_error(r["__status"], r.get("headers")) if "__status" in r else r
              for r in case.get("responses", [])]
    handler = None
    if case.get("batch"):
        by_content = {it["content"]: it["rounds"] for it in case["batch"]["items"]}

        def handler(n, reqs, by_content=by_content):
            return {q["custom_id"]: by_content[q["params"]["messages"][0]["content"]][n - 1] for q in reqs}

    r = Router(data, client=FakeClient(script, handler), sink=sink)
    results, error = [], None
    try:
        if case.get("batch"):
            items = [{"params": {"max_tokens": 100, "messages": [{"role": "user", "content": it["content"]}]}}
                     for it in case["batch"]["items"]]
            results = [x.to_dict() for x in r.route_batch("p", items)]
        else:
            res = r.route("p", case.get("request") or DEFAULT_REQUEST)
            results.append(res.to_dict())
            if case.get("reject"):
                results.append(r.reject(res.task_id, case["reject"]).to_dict())
    except RouterError as e:
        error = type(e).__name__
    for x in results:
        x.pop("message", None)
    out[case["name"]] = {"lines": sink.lines, "payloads": sink.payloads, "results": results, "error": error}

sys.stdout.write(json.dumps(out))
