"""Read-only Superagent P0 probe; emits sanitized local dry-run reports only.
No message sender, credentials reader, cache refresh, or scheduler is included.
"""
import argparse
import json
import os
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

CST = timezone(timedelta(hours=8))


def get_json(url):
    req = Request(url, headers={"x-orchestrator-request": "1"}, method="GET")
    try:
        with urlopen(req, timeout=5) as response:
            data = json.load(response)
            return {"status": response.status, "data": data}
    except HTTPError as exc:
        return {"status": exc.code, "error": "authorization" if exc.code in (401, 403) else "http_error"}
    except (URLError, TimeoutError, OSError, ValueError):
        return {"status": None, "error": "transport_or_schema"}


def pages(base, kind):
    rows, seen, offset, totals = [], set(), 0, []
    for _ in range(10):
        response = get_json(base + "/tickets?state=" + kind + "&limit=100&offset=" + str(offset))
        if response.get("status") != 200 or not isinstance(response.get("data"), dict):
            return rows, {"complete": False, "reason": "request_failed", "status": response.get("status")}
        data = response["data"]
        if not isinstance(data.get("items"), list):
            return rows, {"complete": False, "reason": "schema"}
        totals.append(data.get("total"))
        for row in data["items"]:
            if row.get("id") not in seen:
                seen.add(row.get("id"))
                rows.append(row)
        next_offset = data.get("next_offset")
        if next_offset is None:
            complete = len(set(str(x) for x in totals)) == 1 and totals[-1] == len(rows)
            return rows, {"complete": complete, "total": totals[-1], "consistency": "nontransactional"}
        if not isinstance(next_offset, int) or next_offset <= offset:
            return rows, {"complete": False, "reason": "pagination_not_advancing"}
        offset = next_offset
    return rows, {"complete": False, "reason": "page_budget"}


def selections(value):
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "modelSelection" and isinstance(item, dict):
                selected = item.get("val", {}).get("lastUsed")
                if isinstance(selected, dict):
                    found.append({k: selected.get(k) for k in ("provider", "model", "reasoningEffort")})
            else:
                found.extend(selections(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(selections(item))
    return found


def inspect_models(home, ids):
    result = []
    root = home / "storages/session_projcache/sessions"
    for sid in sorted(set(ids)):
        if not isinstance(sid, str) or not sid or Path(sid).name != sid or "/" in sid or chr(92) in sid:
            continue
        file = root / (sid + ".json")
        try:
            content = json.loads(file.read_text(encoding="utf-8"))
            result.append({"role": ids[sid], "selection": selections(content), "metadataMtime": datetime.fromtimestamp(file.stat().st_mtime, timezone.utc).isoformat(), "quality": "last_selection_only_not_inflight_or_success" if selections(content) else "unknown_selection"})
        except (OSError, ValueError):
            result.append({"role": ids[sid], "selection": [], "quality": "unavailable"})
    return result


def inspect_instance(port, home, day):
    base = "http://127.0.0.1:" + str(port) + "/orchestrator/api"
    response = get_json(base + "/state")
    state = response.get("data", {})
    health = state.get("health", {}) if isinstance(state, dict) else {}
    opened, open_quality = pages(base, "open")
    ended, ended_quality = pages(base, "ended")
    source_errors = [name for name, val in health.items() if isinstance(val, dict) and val.get("state") == "error"]
    session_ids = {}
    master_ids = state.get("masterIds") or []
    if isinstance(master_ids, dict):
        master_ids = list(master_ids.values())
    for sid in [state.get("masterId")] + list(master_ids):
        if isinstance(sid, str) and sid:
            session_ids[sid] = "master"
    for row in opened + ended:
        if row.get("sessionId"):
            session_ids[row["sessionId"]] = "worker_historical" if row.get("ended") else "worker_open"
    today_ended = [r for r in ended if str((r.get("ended") or {}).get("at", "")) and local_day((r.get("ended") or {}).get("at")) == day]
    summary_rows = [r for r in opened if r.get("summary")]
    return {"port": port, "httpStatus": response.get("status"), "health": "unavailable" if response.get("status") != 200 else ("online_degraded" if source_errors else "reachable"), "componentStates": {k: v.get("state") for k, v in health.items() if isinstance(v, dict)}, "errorComponents": source_errors, "paused": state.get("paused"), "loopLiveness": "unverified", "openTickets": len(opened) if open_quality["complete"] else None, "openObserved": len(opened), "openStages": dict(Counter(r.get("stage", "unknown") for r in opened)), "humanItemsObserved": sum(r.get("stage") == "person" for r in opened), "humanActionCounts": dict(Counter(r.get("action", "unknown") for r in opened if r.get("stage") == "person")), "todayCompletedTicketsObserved": sum((r.get("ended") or {}).get("outcome") in ("completed", "merged") for r in today_ended), "todayEndedOutcomes": dict(Counter((r.get("ended") or {}).get("outcome", "unknown") for r in today_ended)), "todayActiveSessions": None, "todayActiveSessionsReason": "execution event feed not read; ticket updates and creation are not execution evidence", "openPagination": open_quality, "endedPagination": ended_quality, "recapAvailability": {"openWithSummary": len(summary_rows), "summaryTimestampInList": "not_proven", "summaryTextExported": False, "fallback": "暂无可用的可追溯摘要"}, "models": inspect_models(home, session_ids)}


def local_day(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(CST).date().isoformat()
    except (ValueError, AttributeError):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    home = Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh")
    now = datetime.now(CST)
    day = now.date().isoformat()
    instances = [inspect_instance(port, home, day) for port in (3082, 3083)]
    counts = Counter()
    root = home / "sessions"
    if root.exists():
        for project in root.iterdir():
            if project.is_dir():
                for directory in project.iterdir():
                    if directory.is_dir():
                        counts["all"] += 1
                        counts["worker" if directory.name.startswith("worker-") else "session" if directory.name.startswith("session-") else "other"] += 1
    dashboard = []
    for port in (3080, 3083):
        response = get_json("http://127.0.0.1:" + str(port) + "/dsh-dashboard/api/status")
        data = response.get("data", {})
        dashboard.append({"port": port, "status": response.get("status"), "error": response.get("error"), "lastScanAt": data.get("lastScanAt"), "scanning": data.get("scanning"), "scanErrorCount": len(data.get("scanErrors", [])) if response.get("status") == 200 and isinstance(data, dict) else None, "tokens": None, "cost": None})
    report = {"schemaVersion": "p0-1", "asOf": now.isoformat(), "timezone": "Asia/Shanghai", "windowStart": day + "T00:00:00+08:00", "windowEnd": now.isoformat(), "mode": "dry-run-no-send", "instances": instances, "sessionDirectoryCounts": dict(counts), "dashboard": dashboard, "modelEvidence": "metadata lastUsed only; no request/response success claims", "privacy": "no raw session history, ticket title, summary text, recipients, credentials or chat ids exported", "snapshotConsistency": "separate GET requests, no atomic revision guarantee"}
    json_path = out / ("p0-snapshot-" + day + ".json")
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# Superagent P0 dry-run 样报", "", "采集时间：" + report["asOf"], "模式：只读采集；未发送任何消息；未运行缓存刷新或定时服务。", "", "## 实际样报"]
    for item in instances:
        lines.extend(["", "### 实例 " + str(item["port"]), "", "- 服务：" + item["health"] + "；HTTP " + str(item["httpStatus"]) + "；异常组件：" + (", ".join(item["errorComponents"]) or "未观测到") + "。调度循环活性未验证。", "- 未完成工单：" + str(item["openTickets"]) + "；已观测状态：" + json.dumps(item["openStages"], ensure_ascii=False) + "。", "- 待人工处理：" + str(item["humanItemsObserved"]) + "（仅工单 person 分类；不代表全部业务决策）。", "- 今日完成工单观测值：" + str(item["todayCompletedTicketsObserved"]) + "；今日活动会话数：未知，缺执行事件证据。", "- recap：有摘要字段的未完成工单 " + str(item["recapAvailability"]["openWithSummary"]) + " 个；摘要时间/事件来源尚未验证，不输出为当前recap。", "- 主控及未完成工单的最近选择模型（历史worker另存快照；不是当前执行或最近成功）：" + json.dumps([m for m in item["models"] if m["role"] != "worker_historical"], ensure_ascii=False) + "。"])
    lines.extend(["", "## 用量与覆盖", "", "dashboard探测：" + json.dumps(dashboard, ensure_ascii=False), "", "模型消耗量和金额：未知，不填零。worker目录计数：" + str(counts["worker"]) + "；目录计数不是活动会话数。", "", "## P0结论", "", "可接入：服务状态、分页工单、person分类、session关联、最近选择模型。", "待补齐：当日执行事件计数、in-flight/成功模型、带来源时间的recap、独立未关闭裁决、dashboard授权及扫描覆盖。", "本轮无消息发送、无凭据读取、无profile变更、无POST请求。采集非原子快照，工单页总数稳定仅证明本次分页数量相符。"])
    md_path = out / ("p0-dry-run-" + day + ".md")
    md_path.write_text(chr(10).join(lines) + chr(10), encoding="utf-8")
    print(json.dumps({"json": str(json_path), "report": str(md_path), "instances": [{"port": i["port"], "health": i["health"], "open": i["openTickets"], "human": i["humanItemsObserved"], "models": i["models"]} for i in instances], "workerDirectories": counts["worker"], "dashboard": dashboard}, ensure_ascii=False))


if __name__ == "__main__":
    main()
