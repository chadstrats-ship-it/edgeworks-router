"""Offline demo: runs the real router against a scripted stand-in for the Anthropic client (no network, no API key).

The stand-in returns canned Messages API responses, so the *routing, validation, cost math and logging are real*;
only the model replies are scripted. Run from the repo root, with the package installed (`pip install -e "python[test]"`):

    python examples/offline_demo.py
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from anthropic.types import Message

from edgeworks_router import FileSink, Router, RoutingConfig
from edgeworks_router.report import build_report, format_report

ROOT = Path(__file__).resolve().parents[1]


def reply(text: str, model: str, inp: int, out: int) -> Message:
    return Message.model_validate({
        "id": "msg_demo", "type": "message", "role": "assistant", "stop_reason": "end_turn", "stop_sequence": None,
        "model": model, "content": [{"type": "text", "text": text}],
        "usage": {"input_tokens": inp, "output_tokens": out}})


class ScriptedMessages:
    def __init__(self, script: list[Message]):
        self.script = list(script)

    def create(self, **kwargs: Any) -> Message:
        print(f"  -> API call: model={kwargs['model']} effort={kwargs.get('output_config', {}).get('effort')}")
        return self.script.pop(0)


class ScriptedClient:
    def __init__(self, script: list[Message]):
        self.messages = ScriptedMessages(script)


def main() -> None:
    home = Path(tempfile.mkdtemp(prefix="edgeworks-demo-"))
    config = RoutingConfig(json.loads((ROOT / "routing.json").read_text(encoding="utf-8")))
    # Task A: Sonnet answers correctly. Task B: Sonnet returns prose (fails the JSON validator) -> Opus fixes it.
    script = [
        reply('{"category":"billing","priority":2,"summary":"Customer was charged twice"}', "claude-sonnet-5-5", 900, 60),
        reply("Sure! This looks like a bug report.", "claude-sonnet-5-5", 900, 40),
        reply('{"category":"bug","priority":3,"summary":"Export button does nothing"}', "claude-opus-5-5", 900, 55),
    ]
    router = Router(config, client=ScriptedClient(script), sink=FileSink(home))
    params = {"max_tokens": 300, "messages": [{"role": "user", "content": "Extract the ticket fields as JSON."}]}
    for label in ("A", "B"):
        print(f"task {label}:")
        res = router.route("extract-ticket-fields", params)
        print(f"  status={res.status} final_step={res.final_step} cost=${res.total_cost_usd:.6f}")
        print(f"  attempts={[(a.step, a.model, a.passed, a.reason) for a in res.attempts]}")
    print("\nlog lines (logs/router-YYYY-MM.jsonl):")
    for f in sorted((home / "logs").glob("router-*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            d = json.loads(line)
            print("  " + json.dumps({k: d[k] for k in ("pipeline", "step", "requested_model", "effort", "input_tokens",
                  "output_tokens", "cost_usd", "validation_passed", "validation_reason", "escalated", "final")}))
    print()
    print(format_report(build_report(FileSink(home).iter_lines(), config, days=30)))


if __name__ == "__main__":
    main()
