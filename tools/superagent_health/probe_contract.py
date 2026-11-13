"""Print only schemas and event model metadata; never chat content."""
import importlib.util
import json
import os
import tempfile
from collections import Counter
from pathlib import Path
from urllib.request import Request, urlopen

extract_path = Path.home() / ".agents/skills/session-summary/scripts/extract.py"
spec = importlib.util.spec_from_file_location("extract", extract_path)
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)
home = Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh")
base = "http://127.0.0.1:3082/orchestrator/api"
def get(path):
    with urlopen(Request(base + path, headers={"x-orchestrator-request": "1"}), timeout=8) as r:
        return json.load(r)
rows = get("/tickets?state=open&limit=100")["items"]
if not rows:
    raise SystemExit("No open ticket")
item = next((r for r in rows if r.get("sessionId")), rows[0])
detail = get("/tickets/" + item["id"])
print(json.dumps({"detailKeys": list(detail), "assignmentKeys": [list(a) for a in detail.get("assignments", [])], "reports": [{"keys": list(a.get("report", {})), "at": a.get("report", {}).get("at"), "hasSummary": bool(a.get("report", {}).get("summary"))} for a in detail.get("assignments", [])]}, ensure_ascii=False))
paths = list((home / "sessions").glob("*/" + item["sessionId"] + "/session.v*.jsonl.zstd"))
if paths:
    chosen = max(paths, key=lambda p: int(p.name.split(".")[1][1:]))
    with tempfile.TemporaryDirectory(prefix="dsh-health-probe-") as scratch:
        events = extract.parse(str(chosen), scratch, extract.find_zstd())
    shapes = {}
    for e in events:
        kind = e.get("type")
        if kind and kind not in shapes:
            d = e.get("data") or {}
            shapes[kind] = {"eventKeys": list(e), "dataKeys": list(d) if isinstance(d, dict) else type(d).__name__}
            if kind == "assistant/message":
                shapes[kind]["source"] = d.get("message", {}).get("source")
            if kind == "request/header":
                shapes[kind]["config"] = {k:v for k,v in d.get("header", {}).get("config", {}).items() if k in ("provider", "model", "reasoningEffort")}
    print(json.dumps({"headerKeys": list(events[0]), "eventCounts": dict(Counter(e.get("type", "header") for e in events)), "shapes": shapes}, ensure_ascii=False))
