"""`router report` (spec §8): per-pipeline calls, escalation, per-step pass rate, cost, opus-only ESTIMATE,
recommendation (PIN TO OPUS / TRY SONNET MEDIUM / KEEP)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from .config import RoutingConfig
from .cost import cost_for_alias

INFRA_PREFIXES = ("infra:", "http_")


def _ts(line: dict[str, Any]) -> datetime | None:
    raw = line.get("timestamp")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def _is_scored_attempt(l: dict[str, Any]) -> bool:
    """Model attempts that count for pass-rate stats (infra/http failure lines excluded)."""
    r = l.get("validation_reason") or ""
    return l.get("role", "attempt") == "attempt" and not any(r.startswith(p) for p in INFRA_PREFIXES)


def build_report(lines: Iterable[dict[str, Any]], cfg: RoutingConfig, days: int = 30,
                 now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    rc = cfg.report_cfg
    pin_rate, pin_window = float(rc.get("pin_escalation_rate", 0.40)), int(rc.get("pin_window", 50))
    med_rate, med_window = float(rc.get("medium_pass_rate", 0.95)), int(rc.get("medium_window", 100))

    by_pipe: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for l in lines:
        t = _ts(l)
        if t is None or t < cutoff:
            continue
        by_pipe.setdefault(l.get("pipeline") or "?", {}).setdefault(l.get("task_id") or "?", []).append(l)

    rows = []
    for pipe in sorted(by_pipe):
        tasks = by_pipe[pipe]
        finals = {tid: ls for tid, ls in tasks.items()
                  if any(x.get("final") and x.get("role", "attempt") == "attempt" for x in ls)}
        # order tasks by their final line's timestamp (for "last N" windows)
        ordered = sorted(finals.items(), key=lambda kv: max(_ts(x) for x in kv[1]))
        escalated_flags = []
        for _tid, ls in ordered:
            steps = {x.get("step") for x in ls if x.get("role", "attempt") == "attempt"}
            escalated_flags.append(len(steps) > 1)
        n_calls = len(ordered)
        esc_rate = (sum(escalated_flags) / n_calls) if n_calls else 0.0

        step_stats: dict[int, list[int]] = {}
        step1_attempts: list[tuple[datetime, bool]] = []
        total_cost = 0.0
        opus_est = 0.0
        for _tid, ls in tasks.items():
            total_cost += sum(float(x.get("cost_usd") or 0) for x in ls)
        for _tid, ls in ordered:
            atts = sorted([x for x in ls if _is_scored_attempt(x)], key=lambda x: (x.get("step") or 0, _ts(x)))
            for x in atts:
                s = int(x.get("step") or 0)
                st = step_stats.setdefault(s, [0, 0])
                st[1] += 1
                st[0] += 1 if x.get("validation_passed") else 0
                if s == 1:
                    step1_attempts.append((_ts(x), bool(x.get("validation_passed"))))
            first_opus = next((x for x in atts if cfg.pricing_alias(x.get("requested_model")) == "opus"), None)
            if first_opus is not None:
                opus_est += float(first_opus.get("cost_usd") or 0)
            elif atts:
                s1 = atts[0]
                tokens = {k: int(s1.get(k) or 0) for k in
                          ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")}
                opus_est += cost_for_alias(cfg, "opus", tokens, bool(s1.get("batch")))

        # recommendation
        pin_sample = escalated_flags[-pin_window:]
        pin_n = len(pin_sample)
        pin_val = (sum(pin_sample) / pin_n) if pin_n else None
        step1_attempts.sort(key=lambda p: p[0])
        med_sample = [ok for _, ok in step1_attempts[-med_window:]]
        med_n = len(med_sample)
        med_val = (sum(med_sample) / med_n) if med_n else None
        if pin_val is not None and pin_val > pin_rate:
            rec = "PIN TO OPUS"
        elif med_val is not None and med_val > med_rate:
            rec = "TRY SONNET MEDIUM"
        else:
            rec = "KEEP"
        savings = opus_est - total_cost
        rows.append({
            "pipeline": pipe, "calls": n_calls, "escalation_rate": round(esc_rate, 4),
            "pass_rate_by_step": {k: round(v[0] / v[1], 4) for k, v in sorted(step_stats.items()) if v[1]},
            "attempts_by_step": {k: v[1] for k, v in sorted(step_stats.items())},
            "total_cost_usd": round(total_cost, 6), "opus_only_est_usd": round(opus_est, 6),
            "savings_usd": round(savings, 6),
            "savings_pct": round(savings / opus_est * 100, 2) if opus_est > 0 else None,
            "recommendation": rec,
            "pin_rule": {"n": pin_n, "escalation_rate": None if pin_val is None else round(pin_val, 4),
                         "threshold": pin_rate, "window": pin_window},
            "medium_rule": {"n": med_n, "step1_pass_rate": None if med_val is None else round(med_val, 4),
                            "threshold": med_rate, "window": med_window},
        })
    tot_cost = round(sum(r["total_cost_usd"] for r in rows), 6)
    tot_est = round(sum(r["opus_only_est_usd"] for r in rows), 6)
    total = {"calls": sum(r["calls"] for r in rows), "total_cost_usd": tot_cost, "opus_only_est_usd": tot_est,
             "savings_usd": round(tot_est - tot_cost, 6),
             "savings_pct": round((tot_est - tot_cost) / tot_est * 100, 2) if tot_est > 0 else None}
    return {"days": days, "generated": now.isoformat(), "pipelines": rows, "total": total}


def format_report(rep: dict[str, Any]) -> str:
    out = [f"edgeworks-router report - last {rep['days']} days",
           "NOTE: opus_only_est is an ESTIMATE (first opus attempt cost, else step-1 tokens repriced at opus; "
           "grader excluded)", ""]
    hdr = (f"{'pipeline':<28}{'calls':>7}{'esc%':>8}  {'pass rate by step':<26}{'cost $':>11}"
           f"{'opus_only ESTIMATE $':>22}{'savings $':>11}{'sav %':>8}  RECOMMENDATION")
    out.append(hdr)
    out.append("-" * len(hdr))
    for r in rep["pipelines"]:
        prs = " ".join(f"s{k}:{v * 100:.0f}%(n={r['attempts_by_step'][k]})" for k, v in r["pass_rate_by_step"].items())
        pct = "-" if r["savings_pct"] is None else f"{r['savings_pct']:.1f}"
        pin, med = r["pin_rule"], r["medium_rule"]
        rule = (f"{r['recommendation']}  [pin: esc={pin['escalation_rate']} n={pin['n']} >{pin['threshold']}? | "
                f"medium: s1pass={med['step1_pass_rate']} n={med['n']} >{med['threshold']}?]")
        out.append(f"{r['pipeline'][:27]:<28}{r['calls']:>7}{r['escalation_rate'] * 100:>7.1f}%  {prs:<26}"
                   f"{r['total_cost_usd']:>11.4f}{r['opus_only_est_usd']:>22.4f}{r['savings_usd']:>11.4f}{pct:>8}  {rule}")
    t = rep["total"]
    pct = "-" if t["savings_pct"] is None else f"{t['savings_pct']:.1f}"
    out.append("-" * len(hdr))
    out.append(f"{'TOTAL':<28}{t['calls']:>7}{'':>8}  {'':<26}{t['total_cost_usd']:>11.4f}"
               f"{t['opus_only_est_usd']:>22.4f}{t['savings_usd']:>11.4f}{pct:>8}")
    return "\n".join(out)
