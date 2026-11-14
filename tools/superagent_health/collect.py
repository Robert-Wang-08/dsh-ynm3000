"""Read-only collection of managed tickets, traceable reports and session events."""
import json
import time
from datetime import datetime
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from common import CST, instant, digest, safe_text
from events import EventReader

# A missing route and a gateway error both appear while a plugin or host reloads; one retry hides the window.
RETRY_STATUSES = (404, 502, 503, 504)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def get(url, attempts=1):
    """Read one JSON answer; `attempts` retries a status a live plugin answers while it reloads."""
    error = None
    for attempt in range(attempts):
        if attempt:
            time.sleep(1.5)
        try:
            with build_opener(NoRedirect).open(Request(url, headers={"x-orchestrator-request": "1"}), timeout=5) as response:
                payload = response.read(16 * 1024 * 1024 + 1)
                if len(payload) > 16 * 1024 * 1024:
                    return None, "response_budget"
                return json.loads(payload), None
        except HTTPError as exc:
            error = "auth_" + str(exc.code) if exc.code in (401, 403) else "http_" + str(exc.code)
            if exc.code not in RETRY_STATUSES:
                return None, error
        except (OSError, ValueError, URLError):
            error = "transport_or_schema"
    return None, error

def tickets(base, state):
    result, ids, total, offset = [], set(), None, 0
    for _ in range(20):
        data, error = get(base + "/tickets?state=" + state + "&limit=100&offset=" + str(offset))
        if error or not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return result, error or "schema"
        if total is not None and total != data.get("total"):
            return result, "changing_pagination"
        total = data.get("total")
        for item in data["items"]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or item.get("stage") not in ("working", "idle", "person", "ended"):
                return result, "ticket_schema"
            if item["id"] not in ids:
                ids.add(item["id"])
                result.append(item)
        next_offset = data.get("next_offset")
        if next_offset is None:
            return result, None if total == len(result) else "incomplete_pagination"
        if not isinstance(next_offset, int) or next_offset <= offset:
            return result, "pagination_cycle"
        offset = next_offset
    return result, "page_budget"

def report_from_detail(detail, ticket_id, updated_at):
    assignments = detail.get("assignments", [])
    if not isinstance(assignments, list):
        return {"text": "暂无可用摘要", "quality": "unavailable"}
    reports = [(a, a.get("report")) for a in assignments if isinstance(a, dict) and isinstance(a.get("report"), dict) and a["report"].get("summary") and a["report"].get("at")]
    if not reports:
        return {"text": "暂无可用摘要", "quality": "unavailable"}
    assignment, report = max(reports, key=lambda pair: pair[1]["at"])
    when, updated = instant(report["at"]), instant(updated_at)
    return {"text": safe_text(report["summary"]), "at": report["at"], "state": report.get("state"),
            "source": "ticket:" + ticket_id + "/assignment:" + assignment["id"] + "/report@" + report["at"],
            "quality": "worker_report_not_independently_verified", "mayBeStale": bool(updated and when and updated > when)}

def instance(config, item, now, reader):
    base = item["url"].rstrip("/") + "/orchestrator/api"
    state, error = get(base + "/state", attempts=2)
    if error or not isinstance(state, dict) or not isinstance(state.get("health"), dict):
        return {"id": item["id"], "health": "unknown", "collectionError": error or "schema", "tickets": [], "sessions": [], "humanItems": [], "quality": "unavailable", "observedAt": now.isoformat()}
    health = state["health"]
    opened, err_open = tickets(base, "open")
    ended, err_ended = tickets(base, "ended")
    quality = "partial" if err_open or err_ended else "observed_nonatomic"
    rows, sessions, human = [], {}, []
    master_ids = state.get("masterIds") or []
    if isinstance(master_ids, dict):
        master_ids = list(master_ids.values())
    for sid in [state.get("masterId")] + list(master_ids):
        if isinstance(sid, str) and sid:
            sessions[sid] = {"id": sid, "role": "master", "events": reader.read(sid, now.date().isoformat(), now)}
    today_completed = 0
    for raw in opened + ended:
        sid, end = raw.get("sessionId"), raw.get("ended")
        end_time = instant((end or {}).get("at"))
        if end_time and end_time <= now and end_time.astimezone(CST).date() == now.date() and end.get("outcome") in ("completed", "merged"):
            today_completed += 1
        if sid and sid not in sessions:
            sessions[sid] = {"id": sid, "role": "worker", "events": reader.read(sid, now.date().isoformat(), now)}
        ev = sessions.get(sid, {}).get("events", {})
        # Preserve every open ticket; ended tickets only appear in detail if active today.
        if end and not ev.get("activeToday") and not (end_time and end_time.astimezone(CST).date() == now.date()):
            continue
        detail, detail_error = get(base + "/tickets/" + raw["id"])
        recap = report_from_detail(detail or {}, raw["id"], raw.get("updatedAt")) if not detail_error else {"text":"暂无可用摘要", "quality":"unavailable"}
        row = {"id": raw["id"], "title": safe_text(raw.get("title"),100), "stage": raw.get("stage", "unknown"), "action": raw.get("action"), "ended": end,
               "sessionId": sid, "updatedAt": raw.get("updatedAt"), "recap": recap, "detailError": detail_error}
        rows.append(row)
        if not end and row["stage"] == "person":
            attention = (detail or {}).get("attention") or {}
            human.append({"issueId": item["id"] + ":" + raw["id"] + ":" + str(attention.get("id") or row["action"] or "person"),
                          "revision": digest([row["updatedAt"], recap.get("source"), attention.get("id")]),
                          "ticketId": raw["id"], "reason": row["action"], "question": safe_text(attention.get("question") or row["title"]),
                          "recap": recap, "owner": "管理人", "deadline": None})
    errors = [k for k,v in health.items() if isinstance(v,dict) and v.get("state") == "error"]
    observed_sessions = list(sessions.values())
    active_count = sum(s["events"].get("activeToday", False) for s in observed_sessions)
    missing = sum(s["events"].get("quality") != "observed" for s in observed_sessions)
    return {"id":item["id"], "health":"online_degraded" if errors else "reachable", "paused": state.get("paused"), "observedAt":now.isoformat(),
            "components": {k:{"state":v.get("state"),"at":v.get("at"),"code":v.get("code")} for k,v in health.items() if isinstance(v,dict)},
            "errorComponents":errors,"loopLiveness":"not_proven_by_http", "quality":quality, "paginationErrors":[e for e in (err_open,err_ended) if e],
            "openTickets": len(opened) if not err_open else None,"todayCompleted":today_completed if not err_ended else None,
            "activeManagedSessionsObserved":active_count,"sessionCoverage":"linked_master_and_ticket_workers_only; child/external sessions not proven",
            "missingSessionEvidence":missing,"tickets":rows,"sessions":observed_sessions,"humanItems":human,
            "humanCoverage":"open_ticket_person; other decisions require source-specific evidence"}

def collect(config, cache, window_end=None):
    start = window_end or datetime.now(CST)
    reader = EventReader(config["home"], cache, config.get("extractor_path"))
    items = [instance(config, item, start, reader) for item in config["instances"]]
    dash = []
    for url in config.get("dashboard_urls", []):
        data, error = get(url.rstrip("/") + "/dsh-dashboard/api/status")
        dash.append({"endpoint":url,"quality":"unavailable" if error else "status_only", "error":error,
                     "lastScanAt":(data or {}).get("lastScanAt"),"scanning":(data or {}).get("scanning"),
                     "coverage":"existing_scanner_excludes_worker_prefix; no_session_set_filter", "tokens":None,"cost":None})
    return {"schemaVersion":1,"windowStart":start.replace(hour=0,minute=0,second=0,microsecond=0).isoformat(),"windowEnd":start.isoformat(),
            "collectedAt":datetime.now(CST).isoformat(),"timezone":"Asia/Shanghai","instances":items,"dashboard":dash,
            "consistency":"non-atomic read-only observations; no source states modified"}
