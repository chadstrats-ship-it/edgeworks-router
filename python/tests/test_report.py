"""`router report` recommendation logic on synthetic logs."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from conftest import OPUS, SONNET, build_config
from edgeworks_router import cli
from edgeworks_router.report import build_report, format_report

NOW = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)


def _line(pipe, tid, step, passed, final, t, model=SONNET, cost=0.01, role="attempt", inp=1000, out=100, batch=False):
    return {"timestamp": t.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "task_id": tid,
            "pipeline": pipe, "step": step, "requested_model": model, "served_model": model,
            "effort": "high", "input_tokens": inp, "output_tokens": out, "cache_read_tokens": 0,
            "cache_write_tokens": 0, "cost_usd": cost, "latency_ms": 1, "validation_passed": passed,
            "validation_reason": None if passed else "json_parse", "escalated": not passed and not final,
            "final": final, "batch": batch, "role": role}


def _task(pipe, i, escalate, t):
    tid = f"{pipe}-{i}"
    if escalate:
        return [_line(pipe, tid, 1, False, False, t), _line(pipe, tid, 2, True, True, t + timedelta(seconds=1),
                                                           model=OPUS, cost=0.02)]
    return [_line(pipe, tid, 1, True, True, t)]


def synthetic():
    lines = []
    t0 = NOW - timedelta(days=2)
    for i in range(10):  # pin: 6/10 escalate -> 0.6 > 0.40
        lines += _task("p-pin", i, i < 6, t0 + timedelta(minutes=i))
    for i in range(20):  # medium: 20/20 pass at step 1 -> 1.0 > 0.95
        lines += _task("p-medium", i, False, t0 + timedelta(minutes=i))
    for i in range(10):  # keep: 2/10 escalate (0.2 <= 0.4); step-1 pass 0.8 (<= 0.95)
        lines += _task("p-keep", i, i < 2, t0 + timedelta(minutes=i))
    # old task outside --days window must be ignored
    lines += _task("p-keep", 99, True, NOW - timedelta(days=45))
    # grader line counts in cost but not in opus_only_est
    lines.append(_line("p-keep", "p-keep-0", 1, True, False, t0, model="claude-haiku-4-5-20251001", cost=0.005,
                       role="grader"))
    return lines


def test_report_recommendation_logic():
    rep = build_report(synthetic(), build_config(), days=30, now=NOW)
    rows = {r["pipeline"]: r for r in rep["pipelines"]}
    assert rows["p-pin"]["recommendation"] == "PIN TO OPUS"
    assert rows["p-pin"]["pin_rule"]["n"] == 10 and rows["p-pin"]["escalation_rate"] == 0.6
    assert rows["p-medium"]["recommendation"] == "TRY SONNET MEDIUM"
    assert rows["p-medium"]["medium_rule"]["n"] == 20 and rows["p-medium"]["medium_rule"]["step1_pass_rate"] == 1.0
    assert rows["p-keep"]["recommendation"] == "KEEP"
    assert rows["p-keep"]["calls"] == 10  # 45-day-old task excluded
    assert rows["p-keep"]["pass_rate_by_step"] == {1: 0.8, 2: 1.0}
    # cost: 8 * 0.01 + 2 * (0.01 + 0.02) + grader 0.005 = 0.145
    assert rows["p-keep"]["total_cost_usd"] == 0.145
    # opus_only_est: escalated tasks -> their opus attempt cost 0.02 each; others -> step1 tokens at opus
    # (1000*4 + 100*20)/1e6 = 0.006 each -> 2*0.02 + 8*0.006 = 0.088
    assert rows["p-keep"]["opus_only_est_usd"] == 0.088
    assert rows["p-keep"]["savings_usd"] == round(0.088 - 0.145, 6)
    assert rep["total"]["calls"] == 40
    text = format_report(rep)
    assert "ESTIMATE" in text and "TOTAL" in text and "PIN TO OPUS" in text and "n=10" in text


def test_report_pin_window_uses_only_last_n_tasks():
    cfg = build_config()
    cfg.data["report"] = {**cfg.data["report"], "pin_window": 5}
    lines = []
    t0 = NOW - timedelta(days=1)
    for i in range(10):  # first 5 escalate, last 5 don't -> last-5 window rate 0.0
        lines += _task("p", i, i < 5, t0 + timedelta(minutes=i))
    [row] = build_report(lines, cfg, days=30, now=NOW)["pipelines"]
    assert row["escalation_rate"] == 0.5 and row["pin_rule"]["n"] == 5 and row["pin_rule"]["escalation_rate"] == 0.0
    assert row["recommendation"] == "KEEP"  # step-1 pass rate 0.5 too


def test_report_batch_step1_repriced_with_discount():
    lines = [_line("b", "b-1", 1, True, True, NOW - timedelta(hours=1), batch=True, cost=0.0015)]
    [row] = build_report(lines, build_config(), days=30, now=NOW)["pipelines"]
    assert row["opus_only_est_usd"] == 0.003  # (1000*4 + 100*20)/1e6 * 0.5


def test_cli_report_reads_home_logs(make_router, home, capsys):
    logs = home / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    with open(logs / f"router-{now:%Y-%m}.jsonl", "w", encoding="utf-8") as fh:
        for l in _task("cli-p", 1, True, now - timedelta(minutes=5)):
            fh.write(json.dumps(l) + "\n")
    r, _ = make_router()
    assert cli.main(["report", "--days", "7"], router=r) == 0
    out = capsys.readouterr().out
    assert "cli-p" in out and "ESTIMATE" in out and "PIN TO OPUS" in out
