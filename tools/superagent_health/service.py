"""Single-tick/daemon health reporting service. Dry-run is the default command."""
import argparse
import json
import sqlite3
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from common import CST, digest, load_config, atomic_text
from collect import collect
from delivery import send, binding, binding_id, DeliveryError
from render import render, chunks
from store import Store

@contextmanager
def process_lock(directory):
    Path(directory).mkdir(parents=True,exist_ok=True)
    lock=open(Path(directory)/"reporter.lock","a+b")
    try:
        if os.name=="nt":
            import msvcrt
            lock.seek(0)
            if not lock.read(1):
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:
        lock.close()
        raise RuntimeError("reporter_already_running")
    try:
        yield
    finally:
        lock.close()


def quiet(now,config):
    start,end=config.get("quiet_hours",[22,8])
    return (now.hour>=start or now.hour<end) if start>end else start<=now.hour<end

def next_open(now,config):
    if not quiet(now,config):
        return now.timestamp()
    end=config.get("quiet_hours",[22,8])[1]
    target=now.replace(hour=end,minute=0,second=0,microsecond=0)
    if target<=now:
        target+=timedelta(days=1)
    return target.timestamp()


def enqueue_report(store,config,snapshot,key,kind,urgent=False,issue=None):
    resolved=binding(config)
    fingerprint=binding_id(config,resolved)
    now=datetime.fromisoformat(snapshot["collectedAt"])
    group=digest([fingerprint,key,config["instances"]])
    parts=chunks(render(snapshot,kind))
    available=now.timestamp() if urgent else max(next_open(now,config),snapshot.get("notBefore",0))
    entries=[]
    for index,text in enumerate(parts):
        part_key=group+"-"+str(index+1)
        payload={"text":text+chr(10)+"报告 "+group+" · "+str(index+1)+"/"+str(len(parts)),"kind":kind,"urgent":urgent,"bindingHash":fingerprint,"issue":issue,
                 "expires":now.timestamp()+86400 if urgent or issue else available+3*3600}
        entries.append((part_key,payload))
    store.enqueue_group(entries,available,created=now.timestamp())
    return group


def plan(store,config,snapshot,now):
    previous=store.get("last_plan_at")
    first_run=previous is None
    if previous is None:
        enqueue_report(store,config,snapshot,"startup:"+now.date().isoformat(),"启动健康报告")
        previous=now.isoformat()
    since=datetime.fromisoformat(previous)
    slots=[now.replace(hour=h,minute=0,second=0,microsecond=0) for h in config.get("schedule_hours",[9,11,13,15,17,19])]
    hour,minute=map(int,config.get("daily_time","21:05").split(":"))
    slots.append(now.replace(hour=hour,minute=minute,second=0,microsecond=0))
    due=[s for s in slots if since<s<=now]
    if due:
        slot=max(due)
        daily=slot.hour==hour and slot.minute==minute
        enqueue_report(store,config,snapshot,"slot:"+slot.isoformat(),"日报快照（未闭账）" if daily else "定期健康报告")
    # Close the previous natural day once, after midnight; deliver at 09:00.
    closing_day=(now-timedelta(days=1)).date().isoformat()
    if not first_run and now.hour*60+now.minute>=10 and not store.get("closed:"+closing_day):
        cutoff=now.replace(hour=0,minute=0,second=0,microsecond=0)-timedelta(microseconds=1)
        closed=collect(config,store.get("event_cache",{}),window_end=cutoff)
        closed["businessStateNote"]="工单当前状态采集于collectedAt；执行事件与完成计数按前日窗口"
        closed["notBefore"]=now.replace(hour=9,minute=0,second=0,microsecond=0).timestamp() if now.hour<9 else now.timestamp()
        group=enqueue_report(store,config,closed,"closed:"+closing_day,"前日自然日闭账（工单状态为本次观测）")
        store.put("closed:"+closing_day,{"group":group,"windowEnd":closed["windowEnd"]})
    for item in snapshot["instances"]:
        key="health:"+item["id"]
        last=store.get(key,{"failure":0,"success":0,"episode":0,"alerted":False,"signature":None})
        unavailable=item["health"]=="unknown"
        last["failure"]=last["failure"]+1 if unavailable else 0
        last["success"]=0 if unavailable else last["success"]+1
        signature=digest([item.get("errorComponents",[]),item.get("collectionError")])
        bad=bool(item.get("errorComponents")) or last["failure"]>=3
        if bad and (not last["alerted"] or signature!=last["signature"]):
            last["episode"]+=1
            enqueue_report(store,config,snapshot,key+":"+str(last["episode"]),"异常健康报告",urgent=unavailable)
            last["alerted"],last["signature"]=True,signature
        elif not bad and last["alerted"] and last["success"]>=2:
            enqueue_report(store,config,snapshot,key+":recover:"+str(last["episode"]),"恢复报告")
            last["alerted"]=False
        store.put(key,last)
        # Only a successful complete ticket read may close a human issue.
        if item.get("quality")!="observed_nonatomic":
            continue
        live={i["issueId"]:i for i in item["humanItems"]}
        known=store.get("issues:"+item["id"],{})
        for ident,issue in live.items():
            state=known.get(ident,{"episode":0,"active":False,"revision":None,"sentKey":None,"reminders":0})
            if not state["active"] or state["revision"]!=issue["revision"]:
                state["episode"]+=1
                key=ident+":"+str(state["episode"])+":"+issue["revision"]
                group=enqueue_report(store,config,snapshot,key,"待人工事项",issue={"id":ident,"revision":issue["revision"],"instanceId":item["id"]})
                state.update(active=True,revision=issue["revision"],sentKey=group+"-1",reminders=0,reminderDay=now.date().isoformat())
            if state.get("reminderDay")!=now.date().isoformat():
                state.update(reminderDay=now.date().isoformat(),reminders=0)
            accepted=store.accepted_at(state["sentKey"])
            delay=1800 if state["reminders"]==0 else 7200
            if accepted and not quiet(now,config) and state["reminders"]<3 and now.timestamp()-accepted>=delay:
                ordinal=state["reminders"]+1
                group=enqueue_report(store,config,snapshot,ident+":remind:"+str(state["episode"])+":"+state["revision"]+":"+now.date().isoformat()+":"+str(ordinal),"待人工提醒",issue={"id":ident,"revision":issue["revision"],"instanceId":item["id"]})
                state.update(sentKey=group+"-1",reminders=ordinal)
            known[ident]=state
        for ident,state in known.items():
            if ident not in live:
                state["active"]=False
        store.put("issues:"+item["id"],known)
    store.put("last_plan_at",now.isoformat())


def dispatch(store,config,snapshot,limit=4):
    fingerprint=binding_id(config,binding(config))
    live_issues={i["issueId"]:i["revision"] for item in snapshot["instances"] for i in item.get("humanItems",[])}
    complete_instances={i["id"] for i in snapshot["instances"] if i.get("quality")=="observed_nonatomic"}
    for _ in range(limit):
        row=store.claim()
        if not row:
            break
        payload=json.loads(row["payload"])
        delivery_now=datetime.now(CST)
        if not payload.get("urgent") and quiet(delivery_now,config):
            with store.db:
                store.db.execute("UPDATE outbox SET state='retry_wait',available=?,lease=NULL WHERE key=?",(next_open(delivery_now,config),row["key"]))
            continue
        if payload["bindingHash"]!=fingerprint:
            store.failed(row["key"],"recipient_binding_changed",permanent=True)
            continue
        issue=payload.get("issue")
        stale_issue=False
        if isinstance(issue,dict) and issue.get("instanceId") in complete_instances:
            stale_issue=live_issues.get(issue.get("id"))!=issue.get("revision")
        elif isinstance(issue,str):
            # Legacy unversioned reminders cannot safely survive an upgrade.
            stale_issue=True
        if time.time()>payload["expires"] or stale_issue:
            with store.db:
                store.db.execute("UPDATE outbox SET state='superseded',lease=NULL WHERE key=?",(row["key"],))
            continue
        try:
            receipt=send(config,payload["text"],row["key"])
            store.accepted(row["key"],receipt)
        except DeliveryError as exc:
            store.failed(row["key"],str(exc),exc.ambiguous,exc.permanent)


def tick(config,allow_send=False):
    directory=Path(config["state_dir"])
    with process_lock(directory):
        store=Store(directory)
        try:
            cache=store.get("event_cache",{})
            snapshot=collect(config,cache)
            store.put("event_cache",cache)
            store.put("last_snapshot",snapshot)
            atomic_text(directory/"latest.json",json.dumps(snapshot,ensure_ascii=False,indent=2))
            atomic_text(directory/"latest.md",render(snapshot))
            if allow_send:
                binding(config)
                plan(store,config,snapshot,datetime.now(CST))
                dispatch(store,config,snapshot)
            heartbeat={"at":datetime.now(CST).isoformat(),"mode":"send_enabled" if allow_send else "dry-run","instances":len(snapshot["instances"]),"outbox":store.stats()}
            atomic_text(directory/"heartbeat.json",json.dumps(heartbeat))
            print(json.dumps(heartbeat))
            return snapshot
        finally:
            store.close()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("command",choices=["dry-run","tick","run","status"])
    parser.add_argument("--config",required=True)
    parser.add_argument("--allow-send",action="store_true")
    args=parser.parse_args()
    if args.command=="dry-run" and args.allow_send:
        parser.error("dry-run cannot enable sending")
    config=load_config(args.config)
    if args.command=="status":
        if args.allow_send:
            parser.error("status cannot enable sending")
        directory=Path(config["state_dir"])
        heartbeat_file=directory/"heartbeat.json"
        heartbeat=json.loads(heartbeat_file.read_text(encoding="utf-8")) if heartbeat_file.is_file() else None
        database=directory/"health.sqlite"
        outbox={}
        if database.is_file():
            connection=sqlite3.connect(database.resolve().as_uri()+"?mode=ro",uri=True,timeout=5)
            try:
                outbox=dict(connection.execute("SELECT state,count(*) FROM outbox GROUP BY state").fetchall())
            finally:
                connection.close()
        print(json.dumps({"heartbeat":heartbeat,"outbox":outbox,"configSendingEnabled":bool(config.get("delivery",{}).get("enabled")),"bindingConfirmed":bool(config.get("delivery",{}).get("binding_confirmed")),"latestReportExists":(directory/"latest.md").is_file()}))
        return
    if args.allow_send:
        binding(config)
    if args.command!="run":
        tick(config,args.allow_send)
        return
    while True:
        started=time.monotonic()
        try:
            tick(config,args.allow_send)
        except Exception as exc:
            print(json.dumps({"at":datetime.now(CST).isoformat(),"errorType":type(exc).__name__}),flush=True)
        time.sleep(max(1,config.get("interval_seconds",60)-(time.monotonic()-started)))

if __name__=="__main__":
    main()
