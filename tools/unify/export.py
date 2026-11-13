#!/usr/bin/env python3
"""export.py — 四源只读导出器 → spec-track 轨道（v1.3 动作 1）

只读：不写任何源文件；只写 --out-root 下 .scratch/unified-<source>/。
约定见同目录 README.md（五条）。
用法: python export.py [--dry-run] [--out-root DIR] [--include-ptc]
"""
from __future__ import annotations
import argparse, json, os, sys
from datetime import datetime
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
OUT_DEFAULT = Path(os.environ.get("SKILLHUB_ROOT", r"D:\src\ynm3000\skillhub")) / ".scratch"
TB = HOME / ".dsh" / "dsh-taskboard.json"
FH = Path(r"D:\src\dsh\focus-hub\mvp\data\project.json")
PTC = Path(r"D:\src\dsh\.ptc\registry.jsonl")

LANES = [("pending", "待开始"), ("active", "进行中"), ("review", "待验收"),
         ("done", "已完成"), ("parked", "暂挂"), ("unknown", "未分类")]
TB_STATUS = {"backlog": "pending", "todo": "pending", "in_progress": "active",
             "in_review": "review", "done": "done", "canceled": "unknown", "archived": "unknown"}
FH_STATUS = {"todo": "pending", "pending": "pending", "active": "active",
             "in_progress": "active", "review": "review", "in_review": "review", "done": "done"}


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read_json(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"__error__": f"{type(exc).__name__}: {exc}"}


def mk(id_, title, status, raw, owner="", acceptor="", note="", project="", session="",
       needs_human=False, gate_since=""):
    return {"id": id_, "title": title, "status": status, "raw_status": raw, "owner": owner,
            "acceptor": acceptor, "note": (note or "")[:240], "project": project,
            "from_session": session, "needs_human": bool(needs_human), "gate_since": gate_since or ""}


def load_taskboard() -> tuple[list, dict]:
    d = read_json(TB)
    if "__error__" in d:
        return [], {"source": "taskboard", "status": "unavailable", "detail": d["__error__"]}
    raw = d.get("tasks") or []
    items = raw.values() if isinstance(raw, dict) else raw
    out = [mk(t.get("id") or t.get("taskId"), t.get("title") or t.get("name") or "(untitled)",
              TB_STATUS.get(str(t.get("status", "")).lower(), "unknown"), t.get("status"),
              owner=t.get("claimedBy") or t.get("assignee") or "",
              note=t.get("description") or "", project=t.get("workspaceId") or "",
              session=t.get("taskSessionId") or t.get("sessionId") or "",
              needs_human=bool(t.get("waitingForHuman") or t.get("blocked")),
              gate_since=t.get("waitingSince") or t.get("updatedAt") or "") for t in items]
    return out, {"source": "taskboard", "status": "ok", "revision": d.get("revision")}


def load_focus_hub() -> tuple[list, dict]:
    d = read_json(FH)
    if "__error__" in d:
        return [], {"source": "focus-hub", "status": "unavailable", "detail": d["__error__"]}
    out = [mk(t.get("id"), t.get("title") or t.get("id") or "(untitled)",
              FH_STATUS.get(str(t.get("status", "")).lower(), "unknown"), t.get("status"),
              owner=t.get("owner") or "", acceptor=t.get("acceptedBy") or "",
              note=t.get("note") or t.get("summary") or "", project=t.get("projectId") or "",
              session=t.get("session") or "",
              needs_human=str(t.get("status", "")).lower() in {"in_review", "review"}
              or bool(t.get("needsHuman")),
              gate_since=t.get("updatedAt") or t.get("reviewedAt") or "") for t in d.get("tasks") or []]
    out += [mk(p.get("id"), p.get("title") or p.get("id") or "(parked)", "parked", "parked",
               note=f"from={p.get('from', '')} reason={p.get('reason', '')}",
               session=p.get("fromSession") or "") for p in d.get("parked") or []]
    return out, {"source": "focus-hub", "status": "ok", "rev": d.get("rev"),
                 "projects": len(d.get("projects") or [])}


def load_ptc() -> tuple[list, dict]:
    """PTC 是事件账本不是任务库：仅取根任务 id，状态一律 unknown（不臆造 active）。"""
    if not PTC.exists():
        return [], {"source": "ptc", "status": "unavailable", "detail": "ledger not found"}
    seen = {}
    for line in PTC.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        tid = ev.get("task_id") or ev.get("root_task_id")
        if tid and tid not in seen:
            seen[tid] = mk(tid, ev.get("objective") or tid, "unknown", "event")
    return list(seen.values()), {"source": "ptc", "status": "ok", "note": "events-not-tasks"}


LANE_IDS = {k: "lane_" + k for k, _ in LANES}


def build(source: str, tasks: list) -> dict:
    """spec-track v1 落盘形状：feature_id + 扁平 stations（stage_id 用泳道）。"""
    stations = []
    # 粒度对齐：Stage=泳道；任务不是 station（否则 N 个任务塌成一个站），
    # 而是挂在该 station 的 features 上，由 track_model 的 _lift_embedded_work_items 提升为 work_items。
    buckets = {k: [] for k in LANE_IDS}
    for t in tasks:
        lane = t["status"] if t["status"] in LANE_IDS else "unknown"
        buckets[lane].append({
            "work_item_id": f"{source}:{t['id']}", "title": t["title"],
            # spec-track 只有 4 值：review/parked 不可映成 pending（会丢掉"待验收/暂挂"），
            # 分别映到 active / pending，并由 stage_id(lane) + raw_status 保留真实语义。
            "status": {"done": "done", "active": "active", "review": "active"}.get(lane, "pending"),
            "current_station_id": LANE_IDS[lane],
            "note": f"[{lane}] {t['note']}".strip(),
            "owner": t["owner"], "acceptor": t["acceptor"], "project": t["project"],
            "sessionRef": t["from_session"], "needsHuman": t["needs_human"],
            "gateSince": t["gate_since"], "raw_status": t["raw_status"], "source": source})
    stations = [{"stage_id": LANE_IDS[k], "station_id": LANE_IDS[k], "title": label,
                 "status": "active" if buckets[k] else "pending",
                 "artifact_path": None, "note": f"{len(buckets[k])} 项",
                 "features": buckets[k]} for k, label in LANES]
    return {"version": "1", "feature_id": f"unified-{source}",
            "title": f"[{source}] 任务轨道（只读导出）", "spec_ref": None,
            "meta": {"generator": "tools/unify/export.py", "exported_at": now(),
                     "read_only": True, "writes": 0},
            "stations": stations}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-root", default=str(OUT_DEFAULT))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--include-ptc", action="store_true")
    a = ap.parse_args()
    out_root = Path(a.out_root)
    tpl = {"version": "1", "description": "unified lanes (export.py 生成)",
           "gate_before_stage": None, "gate_requires_coverage": [],
           "stages": [{"id": LANE_IDS[k], "title": label, "artifact_kind": None,
                       "optional": k in {"parked", "unknown"}} for k, label in LANES]}
    if not a.dry_run:
        out_root.mkdir(parents=True, exist_ok=True)
        (out_root / "unified-lanes-template.json").write_text(
            json.dumps(tpl, ensure_ascii=False, indent=2), encoding="utf-8")
    loaders = [load_taskboard, load_focus_hub] + ([load_ptc] if a.include_ptc else [])
    summary, written = [], []
    for loader in loaders:
        tasks, meta = loader()
        track = build(meta["source"], tasks)
        summary.append({"source": meta["source"], "status": meta["status"],
                        "tasks": len(tasks),
                        "lanes": {s["stage_id"]: s["note"] for s in track["stations"]},
                        "meta": meta})
        if a.dry_run or meta["status"] != "ok":
            continue
        slug = track["feature_id"]
        d = out_root / slug
        d.mkdir(parents=True, exist_ok=True)
        (d / "feature-track.json").write_text(json.dumps(track, ensure_ascii=False, indent=2),
                                              encoding="utf-8")
        with (d / "feature-track.history.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"kind": "export_snapshot", "track_id": slug,
                                 "ts": now(), "actor": "export.py", "tasks": len(tasks)},
                                ensure_ascii=False) + "\n")
        written.append(str(d / "feature-track.json"))
    print(json.dumps({"ok": True, "dry_run": a.dry_run, "out_root": str(out_root),
                      "sources": summary, "written": written}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
