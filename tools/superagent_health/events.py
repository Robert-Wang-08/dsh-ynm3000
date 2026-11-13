"""Summarize bounded managed session logs using the installed extractor.
Raw chats remain in memory/scratch only and are never copied to report storage.
"""
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from common import instant, iso

class EventReader:
    def __init__(self, home, cache, extractor_path=None):
        self.home, self.cache = Path(home), cache
        self.extractor_path = Path(extractor_path or Path.home() / ".agents/skills/session-summary/scripts/extract.py")
        self.extractor = None
        self.index = None

    def _load(self):
        if self.extractor is None:
            spec = importlib.util.spec_from_file_location("health_extract", self.extractor_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.extractor = module
        return self.extractor

    def read(self, sid, day, now):
        if not isinstance(sid, str) or Path(sid).name != sid or "/" in sid or chr(92) in sid:
            return {"quality": "invalid_session_id"}
        if self.index is None:
            self.index = {}
            for project in (self.home / "sessions").iterdir():
                if project.is_dir():
                    for directory in project.iterdir():
                        if directory.is_dir():
                            self.index.setdefault(directory.name, []).append(directory)
        dirs = self.index.get(sid, [])
        if len(dirs) != 1:
            return {"quality": "missing_or_ambiguous_storage"}
        candidates = list(dirs[0].glob("session.v*.jsonl.zstd"))
        if not candidates:
            return {"quality": "missing_log"}
        try:
            source = max(candidates, key=lambda p: int(p.name.split(".")[1][1:]))
            stat = source.stat()
            key = str(source) + ":" + day
            fingerprint = str(stat.st_mtime_ns) + ":" + str(stat.st_size)
            cached = self.cache.get(key)
            if cached and cached.get("fingerprint") == fingerprint:
                return cached["value"]
            if stat.st_size > 64 * 1024 * 1024:
                return {"quality": "log_size_budget"}
            extract = self._load()
            with tempfile.TemporaryDirectory(prefix="health-events-") as scratch:
                events = extract.parse(str(source), scratch, extract.find_zstd())
            result = fold_events(events, day, now)
            result["storageNamespace"] = dirs[0].parent.name
            result["readAt"] = now.isoformat()
            result["fingerprint"] = fingerprint
            if not any(instant(e.get("time")) and instant(e.get("time")) > now for e in events):
                self.cache[key] = {"fingerprint": fingerprint, "value": result}
            return result
        except (OSError, ValueError, RuntimeError, ImportError) as exc:
            return {"quality": "event_read_unavailable", "errorType": type(exc).__name__}


def fold_events(events, day, now):
    result = {"quality": "observed", "activeToday": False, "executionEvents": 0,
              "lastExecutionAt": None, "latestRequest": None, "lastResponse": None,
              "inFlight": None, "tokens": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
              "usageResponses": 0, "responsesWithoutUsage": 0, "childrenCoverage": "not_verified"}
    request, pending, seen = {}, None, set()
    for event in events:
        kind, data = event.get("type"), event.get("data") or {}
        when = instant(event.get("time"))
        if not when or when > now or not isinstance(data, dict):
            continue
        source_id = "event:" + str(event.get("seq"))
        today = when.astimezone(now.tzinfo).date().isoformat() == day
        if kind in ("turn/start", "step/start", "assistant/message", "tool/call", "tool/result", "step/end", "turn/end"):
            result["lastExecutionAt"] = when.isoformat()
            if today:
                result["activeToday"] = True
                result["executionEvents"] += 1
        if kind == "request/header":
            request = data.get("header", {}).get("config", {})
        elif kind == "request/context":
            request = {**request, **{k: data[k] for k in ("provider", "model", "reasoningEffort") if k in data}}
        if kind in ("step/start", "request/context"):
            pending = {"provider": request.get("provider"), "model": request.get("model"), "effort": request.get("reasoningEffort"), "at": when.isoformat(), "source": source_id}
            result["latestRequest"] = pending
        if kind == "assistant/message":
            src = data.get("message", {}).get("source", {})
            response = {"provider": src.get("provider"), "model": src.get("model"), "at": when.isoformat(), "source": source_id}
            if response["model"]:
                result["lastResponse"] = response
            pending = None
            if today and source_id not in seen:
                seen.add(source_id)
                usage = data.get("usage")
                if isinstance(usage, dict):
                    result["usageResponses"] += 1
                    for short, long in (("input", "inputTokens"), ("output", "outputTokens"), ("cacheRead", "cacheReadTokens"), ("cacheWrite", "cacheWriteTokens")):
                        value = usage.get(long)
                        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                            result["tokens"][short] += value
                else:
                    result["responsesWithoutUsage"] += 1
        if kind in ("step/end", "turn/end"):
            pending = None
    # Persisted unmatched steps are only candidates: a crashed process can leave them open.
    result["inFlight"] = {**pending, "quality": "unmatched_persisted_step_not_live_proof"} if pending else None
    if result["usageResponses"] == 0:
        result["tokens"] = None
    return result
