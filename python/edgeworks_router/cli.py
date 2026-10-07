"""`router` CLI (spec §8): reject | report [--days N] | spend | batch <pipeline> <input.jsonl> [--out f]."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .config import RoutingConfig, spend_cap
from .errors import RouterError
from .report import build_report, format_report
from .router import Router
from .sinks import FileSink


def _dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, default=str)


def _file_sink(router: Router) -> FileSink:
    sink = router.sink
    if not isinstance(sink, FileSink):
        raise RouterError("this command needs the file sink")
    return sink


def cmd_reject(router: Router, args: argparse.Namespace) -> int:
    result = router.reject(args.task_id, args.reason)
    data = result.to_dict()
    sink = _file_sink(router)
    out_dir = sink.logs / "rejections"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{result.task_id}.json").write_text(_dump(data), encoding="utf-8")
    print(_dump(data))
    return 0 if result.passed else 2


def cmd_report(router: Router, args: argparse.Namespace) -> int:
    sink = _file_sink(router)
    rep = build_report(sink.iter_lines(), router.config, days=args.days)
    print(_dump(rep) if args.json else format_report(rep))
    return 0


def cmd_spend(router: Router, args: argparse.Namespace) -> int:
    total = router.sink.total_spend()
    cap = spend_cap()
    cap_s = f"${cap:.2f}" if cap is not None else "none (EDGEWORKS_ROUTER_SPEND_CAP_USD unset)"
    print(f"total spend: ${total:.6f}   cap: {cap_s}")
    return 0


def cmd_batch(router: Router, args: argparse.Namespace) -> int:
    items = []
    with open(args.input, "r", encoding="utf-8") as fh:
        for raw in fh:
            if raw.strip():
                items.append(json.loads(raw))
    results = router.route_batch(args.pipeline, items)
    lines = [json.dumps(r.to_dict(), ensure_ascii=False, default=str) for r in results]
    if args.out:
        Path(args.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
        passed = sum(1 for r in results if r.passed)
        print(f"{passed}/{len(results)} passed; results -> {args.out}")
    else:
        print("\n".join(lines))
    return 0 if all(r.passed for r in results) else 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="router", description="edgeworks-router CLI")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("reject", help="log a human rejection and re-run from the first opus step")
    r.add_argument("task_id")
    r.add_argument("--reason", required=True)
    r.set_defaults(fn=cmd_reject)
    rp = sub.add_parser("report", help="per-pipeline escalation/cost report")
    rp.add_argument("--days", type=int, default=30)
    rp.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    rp.set_defaults(fn=cmd_report)
    s = sub.add_parser("spend", help="total cost across all logs")
    s.set_defaults(fn=cmd_spend)
    b = sub.add_parser("batch", help="run a batchable pipeline over a JSONL of {custom_id?, params}")
    b.add_argument("pipeline")
    b.add_argument("input")
    b.add_argument("--out")
    b.set_defaults(fn=cmd_batch)
    return p


def main(argv: list[str] | None = None, router: Router | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        router = router or Router(RoutingConfig.load())
        return int(args.fn(router, args))
    except RouterError as exc:
        print(f"router: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
