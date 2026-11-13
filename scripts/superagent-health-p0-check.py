"""Focused checks for unknown/zero, pagination, and timezone semantics."""
import importlib.util
from unittest.mock import patch
from pathlib import Path
spec = importlib.util.spec_from_file_location("p0", Path(__file__).with_name("superagent-health-p0.py"))
p0 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p0)
assert p0.local_day("2026-11-11T16:00:00Z") == "2026-11-12"
assert p0.local_day("bad") is None
with patch.object(p0, "get_json", return_value={"status": 401}):
    rows, quality = p0.pages("http://localhost", "open")
    assert rows == [] and quality["complete"] is False
with patch.object(p0, "get_json", return_value={"status": 200, "data": {"items": [], "total": 0, "next_offset": None}}):
    rows, quality = p0.pages("http://localhost", "open")
    assert quality["complete"] is True and quality["total"] == 0
with patch.object(p0, "get_json", side_effect=[{"status": 200, "data": {"items": [{"id": "a"}], "total": 2, "next_offset": 1}}, {"status": 200, "data": {"items": [{"id": "b"}], "total": 2, "next_offset": None}}]):
    rows, quality = p0.pages("http://localhost", "open")
    assert len(rows) == 2 and quality["complete"]
with patch.object(p0, "get_json", return_value={"status": 200, "data": {"items": [{"id": "a"}], "total": 2, "next_offset": 0}}):
    rows, quality = p0.pages("http://localhost", "open")
    assert not quality["complete"] and quality["reason"] == "pagination_not_advancing"
assert p0.selections({"modelSelection": {"val": {"lastUsed": {"provider": "p", "model": "m"}}}})[0]["model"] == "m"
assert p0.selections({"modelSelection": {"val": {}}}) == []
print("PASS: 8 focused assertions (timezone, bad time, auth != zero, empty complete, pagination, nonadvance, selected model, missing model)")
