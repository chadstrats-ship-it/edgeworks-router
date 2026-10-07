"""Pluggable sinks (spec §6): write_line(obj), save_payload(id, obj), total_spend().

FileSink = logs/router-YYYY-MM.jsonl (UTC month of the line timestamp), logs/payloads/<task_id>.json.
NoopSink = discards everything. MemorySink = in-process list (tests/tools).
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Iterator

from .config import router_home


class NoopSink:
    def write_line(self, obj: dict[str, Any]) -> None:
        pass

    def save_payload(self, task_id: str, obj: dict[str, Any]) -> None:
        pass

    def load_payload(self, task_id: str) -> dict[str, Any] | None:
        return None

    def total_spend(self) -> float:
        return 0.0


class MemorySink(NoopSink):
    def __init__(self) -> None:
        self.lines: list[dict[str, Any]] = []
        self.payloads: dict[str, dict[str, Any]] = {}

    def write_line(self, obj: dict[str, Any]) -> None:
        self.lines.append(json.loads(json.dumps(obj)))

    def save_payload(self, task_id: str, obj: dict[str, Any]) -> None:
        self.payloads[task_id] = json.loads(json.dumps(obj))

    def load_payload(self, task_id: str) -> dict[str, Any] | None:
        return self.payloads.get(task_id)

    def total_spend(self) -> float:
        return round(sum(float(l.get("cost_usd") or 0) for l in self.lines), 6)


class FileSink:
    def __init__(self, home: str | os.PathLike | None = None) -> None:
        self.home = Path(home) if home else router_home()
        self.logs = self.home / "logs"
        self.payload_dir = self.logs / "payloads"
        self._lock = threading.Lock()
        self._spend_cache: dict[str, tuple[int, float]] = {}  # file -> (byte offset consumed, sum)

    # ---- lines -------------------------------------------------------------------------------
    def write_line(self, obj: dict[str, Any]) -> None:
        ts = str(obj.get("timestamp") or "")
        month = ts[:7] if len(ts) >= 7 else "unknown"
        self.logs.mkdir(parents=True, exist_ok=True)
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock, open(self.logs / f"router-{month}.jsonl", "a", encoding="utf-8", newline="\n") as fh:
            fh.write(line)

    def log_files(self) -> list[Path]:
        if not self.logs.is_dir():
            return []
        return sorted(self.logs.glob("router-*.jsonl"))

    def iter_lines(self) -> Iterator[dict[str, Any]]:
        for f in self.log_files():
            with open(f, "r", encoding="utf-8") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        yield json.loads(raw)
                    except json.JSONDecodeError:
                        continue

    # ---- payloads ----------------------------------------------------------------------------
    def save_payload(self, task_id: str, obj: dict[str, Any]) -> None:
        self.payload_dir.mkdir(parents=True, exist_ok=True)
        with open(self.payload_dir / f"{task_id}.json", "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)

    def load_payload(self, task_id: str) -> dict[str, Any] | None:
        p = self.payload_dir / f"{task_id}.json"
        if not p.is_file():
            return None
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)

    # ---- spend (incremental: only new bytes of each file are parsed) -----------------------
    def total_spend(self) -> float:
        total = 0.0
        with self._lock:
            for f in self.log_files():
                key = str(f)
                offset, acc = self._spend_cache.get(key, (0, 0.0))
                size = f.stat().st_size
                if size < offset:  # truncated/rotated -> rescan
                    offset, acc = 0, 0.0
                if size > offset:
                    with open(f, "rb") as fh:
                        fh.seek(offset)
                        chunk = fh.read(size - offset)
                    end = chunk.rfind(b"\n")
                    if end >= 0:
                        for raw in chunk[: end + 1].splitlines():
                            if not raw.strip():
                                continue
                            try:
                                acc += float(json.loads(raw).get("cost_usd") or 0)
                            except (ValueError, AttributeError):
                                continue
                        offset += end + 1
                self._spend_cache[key] = (offset, acc)
                total += acc
        return round(total, 6)
