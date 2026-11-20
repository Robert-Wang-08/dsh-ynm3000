"""Single-tick/daemon health reporting service. Dry-run is the default command."""
import argparse
import hashlib
import json
import shutil
import sqlite3
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from common import CST, digest, instant, load_config, atomic_text
from collect import collect
from delivery import send, binding, binding_id, DeliveryError
from deploy import deployment_state
from publish import publish_report, configured as links_configured, PublishError
from render import report_text, render, render_brief, chunks
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


STATE_COPY_SKIP=("health.sqlite","health.sqlite-wal","health.sqlite-shm","reporter.lock")

def _sha256(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()

def _sqlite_summary(database):
    connection=sqlite3.connect(str(database),timeout=5)
    try:
        integrity=str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        try:
            outbox=dict(connection.execute("SELECT state,count(*) FROM outbox GROUP BY state").fetchall())
        except sqlite3.DatabaseError:
            outbox={}
        return integrity,outbox
    finally:
        connection.close()

@contextmanager
def _acquire_lock(directory,wait=60.0):
    """Wait for a running tick to finish instead of failing the first attempt."""
    deadline=time.monotonic()+max(0.0,wait)
    while True:
        try:
            with process_lock(directory):
                yield
                return
        except RuntimeError:
            if time.monotonic()>=deadline:
                raise
            time.sleep(0.5)

def migrate_state(config,config_path,target,write_config=False,keep_old=False,wait=60.0):
    """Move the runtime state to another folder, keeping dedupe and delivery evidence.

    A live SQLite database under a sync client must not be copied file-by-file: the SQLite
    backup API takes a consistent snapshot including any committed WAL content, and the nested
    reporter lock keeps a scheduled tick from writing while the copy is verified.
    """
    source=Path(config["state_dir"]).expanduser().resolve()
    if not str(target or "").strip():
        raise ValueError("state_target_required")
    target=Path(os.path.expandvars(str(target))).expanduser().resolve()
    if source==target:
        raise ValueError("state_target_same_as_source")
    if source in target.parents or target in source.parents:
        raise ValueError("state_target_nested")
    if not source.is_dir():
        raise ValueError("state_source_missing")
    if (target/"health.sqlite").exists():
        raise ValueError("state_target_already_has_state")
    target.mkdir(parents=True,exist_ok=True)
    with _acquire_lock(source,wait):
        with _acquire_lock(target,wait):
            copied=0
            if (source/"health.sqlite").is_file():
                origin=sqlite3.connect(str(source/"health.sqlite"))
                destination=sqlite3.connect(str(target/"health.sqlite"))
                try:
                    origin.backup(destination)
                finally:
                    destination.close()
                    origin.close()
                source_integrity,source_outbox=_sqlite_summary(source/"health.sqlite")
                target_integrity,target_outbox=_sqlite_summary(target/"health.sqlite")
                if source_integrity!="ok":
                    raise RuntimeError("state_source_integrity_failed")
                if target_integrity!="ok":
                    raise RuntimeError("state_copy_integrity_failed")
                if source_outbox!=target_outbox:
                    raise RuntimeError("state_copy_outbox_mismatch")
            else:
                Store(target).close()
            for item in sorted(source.iterdir()):
                if item.name in STATE_COPY_SKIP or item.name.endswith(".tmp"):
                    continue
                if not item.is_file():
                    continue
                destination_file=target/item.name
                shutil.copy2(item,destination_file)
                if _sha256(item)!=_sha256(destination_file):
                    raise RuntimeError("state_copy_checksum_mismatch:"+item.name)
                copied+=1
            result={"source":str(source),"target":str(target),"filesCopied":copied,
                    "databaseCopied":(source/"health.sqlite").is_file(),
                    "outbox":_sqlite_summary(target/"health.sqlite")[1],
                    "configUpdated":False,"oldStateMovedTo":None}
            if write_config:
                raw=json.loads(Path(config_path).read_text(encoding="utf-8-sig"))
                raw["state_dir"]=str(target)
                atomic_text(config_path,json.dumps(raw,ensure_ascii=False,indent=2)+chr(10))
                result["configUpdated"]=True
    # The lock file lives inside the source folder, so the rename happens after it is closed.
    if write_config and not keep_old:
        moved=source.with_name(source.name+".migrated-"+datetime.now(CST).strftime("%Y%m%d-%H%M%S"))
        if moved.exists():
            raise RuntimeError("state_backup_target_exists")
        source.rename(moved)
        result["oldStateMovedTo"]=str(moved)
    return result

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


# A ticket must stay unchanged this long before its first human-attention notice, so a person who is
# already answering in the source thread is not interrupted by a notification that repeats the question.
ATTENTION_SETTLE_DEFAULT=900
# An unbounded value would silently never notify; 0 keeps the old immediate behavior if a device asks for it.
ATTENTION_SETTLE_MAX=3600

# A degraded component is only an incident after the same error signature persists this many samples:
# a source that flaps once (a poll retry, a plugin reload) must not page anyone.
HEALTH_ALERT_CONFIRM=3
# A recovery is announced after a sustained healthy run, not on the first green sample.
HEALTH_RECOVERY_CONFIRM=3
# One delivered incident is not repeated for the same instance inside this window, so a flapping
# component cannot page once a minute. A new episode is still reported by the scheduled report.
HEALTH_REALERT_COOLDOWN=900

def settle_seconds(config):
    try:
        value=float(config.get("attention_settle_seconds",ATTENTION_SETTLE_DEFAULT))
    except (TypeError,ValueError):
        value=ATTENTION_SETTLE_DEFAULT
    return min(max(value,0.0),ATTENTION_SETTLE_MAX)


def alert_delivered(store,last):
    """True when the last alert reached (or may have reached) the channel; a queued one was never seen."""
    group=last.get("alertKey")
    if not group:
        # State written before alert keys existed cannot be checked; keep the old recovery behavior.
        return bool(last.get("alerted"))
    return store.state_of(group+"-1") in ("channel_accepted","unknown_delivery","sending")

def alert_cooldown_ok(store,last,now):
    """Cooldown starts at delivery when known, so a notice read this morning is not repeated at once."""
    group=last.get("alertKey")
    when=store.accepted_at(group+"-1") if group else None
    if when is None:
        when=last.get("alertedAt")
    return when is None or now.timestamp()-float(when)>=HEALTH_REALERT_COOLDOWN

def supersede_unseen_alert(store,last):
    """Drop an alert queued for an older condition; its recovery message is unnecessary too."""
    group=last.get("alertKey")
    if group:
        store.supersede_group(group)
    last["alertKey"]=None
    last["alertedAt"]=None


# A full report is the kind the manager may want only as a brief plus links. Focused
# notices (incident, attention, reminder) stay as they are: they are already short and
# point at the scheduled report.
FULL_REPORTS={"启动健康报告":"startup","定期健康报告":"scheduled","日报快照":"daily-snapshot","前日自然日闭账":"daily-close"}

def full_report(kind):
    return any(str(kind).startswith(prefix) for prefix in FULL_REPORTS)

def report_slug(kind):
    for prefix,slug in FULL_REPORTS.items():
        if str(kind).startswith(prefix):
            return slug
    return "report"

def local_report(config,kind,text,snapshot):
    """Keep one Markdown file per report, so the path in the message stays valid.

    `latest.md` is overwritten every tick; a message that names only it would lose
    the report the manager was reading. The filename carries the collection time.
    """
    stamp=datetime.fromisoformat(snapshot["collectedAt"]).astimezone(CST).strftime("%Y%m%d-%H%M")
    folder=Path(config["state_dir"])/"reports"
    folder.mkdir(parents=True,exist_ok=True)
    target=folder/(stamp+"-"+report_slug(kind)+".md")
    atomic_text(target,text)
    return str(target)

def report_links(config,kind,text,snapshot):
    """The Feishu document and local file for a full report, or why no link was made.

    Returns (links, error). The local file is written first: it must exist before the
    message names it. When the document cannot be created the caller sends the full
    text instead, so a publish failure never hides the report.
    """
    if not full_report(kind) or not links_configured(config):
        return None,None
    try:
        local=local_report(config,kind,text,snapshot)
    except OSError:
        # A read-only or full disk must not stop the report from reaching the chat.
        local=None
    collected=datetime.fromisoformat(snapshot["collectedAt"]).astimezone(CST).strftime("%Y-%m-%d %H:%M")
    title="Superagent · "+kind+" · "+collected
    try:
        document=publish_report(config,title,text)
    except (DeliveryError,PublishError) as exc:
        return ({"local":local} if local else None),str(exc)
    links={"feishu":document["url"]}
    if local:
        links["local"]=local
    return links,None

def report_body(config,snapshot,kind,text,links):
    """Full or brief text with the links block; brief only when a Feishu copy exists."""
    style=str(((config.get("delivery") or {}).get("chat_style") or "full")).strip().lower()
    if links and links.get("feishu") and style=="brief":
        return render_brief(snapshot,kind,links)
    if links:
        return render(snapshot,kind,links)
    return text

def enqueue_report(store,config,snapshot,key,kind,urgent=False,issue=None,health=None):
    resolved=binding(config)
    fingerprint=binding_id(config,resolved)
    now=datetime.fromisoformat(snapshot["collectedAt"])
    group=digest([fingerprint,key,config["instances"]])
    if store.state_of(group+"-1") is not None:
        # The same report is already queued or delivered; do not create a second document.
        return group
    text=report_text(snapshot,kind,issue,health,state_dir=config.get("state_dir"))
    links,error=report_links(config,kind,text,snapshot)
    body=report_body(config,snapshot,kind,text,links)
    if error:
        body+=chr(10)+chr(10)+"**提示**：飞书文档未生成（"+error+"），本次直接发送完整内容。"
    parts=chunks(body)
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
    slots=[now.replace(hour=h,minute=0,second=0,microsecond=0) for h in config.get("schedule_hours",[9,13,17])]
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
        last=store.get(key,{})
        for field in ("failure","success","episode"):
            last.setdefault(field,0)
        last.setdefault("alerted",False)
        last.setdefault("signature",None)
        unavailable=item["health"]=="unknown"
        component_bad=bool(item.get("errorComponents"))
        last["failure"]=last["failure"]+1 if unavailable else 0
        # A degraded sample is not a healthy one: counting it would let the first green sample after
        # a long component outage satisfy the whole recovery confirmation.
        last["success"]=0 if unavailable or component_bad else last["success"]+1
        signature=digest([item.get("errorComponents",[]),item.get("collectionError")])
        # Confirm a component error locally: the source already retries its own poll, and a single
        # flapping sample must not turn one transient failure into an incident message.
        if component_bad:
            if last.get("pendingSignature")==signature:
                last["pendingSamples"]=int(last.get("pendingSamples") or 0)+1
            else:
                last["pendingSignature"],last["pendingSamples"]=signature,1
        else:
            last["pendingSignature"],last["pendingSamples"]=None,0
        # A collection outage keeps its source-level three-failure confirmation; a component error
        # needs the local confirmation above.
        confirmed=last["failure"]>=3 or (component_bad and last["pendingSamples"]>=HEALTH_ALERT_CONFIRM)
        alerted=bool(last.get("alerted"))
        if confirmed and (not alerted or signature!=last.get("signature")):
            suppress=False
            if alerted and not alert_delivered(store,last):
                # The queued alert describes an older condition and nobody saw it; replace it.
                supersede_unseen_alert(store,last)
            elif not alert_cooldown_ok(store,last,now):
                # The delivered alert already covers this episode; wait out the cooldown.
                suppress=True
            if not suppress:
                last["episode"]+=1
                group=enqueue_report(store,config,snapshot,key+":"+str(last["episode"]),"异常健康报告",
                                     urgent=unavailable,health={"instanceId":item["id"]})
                last.update(alerted=True,signature=signature,alertKey=group,alertedAt=now.timestamp(),
                            alertComponents=list(item.get("errorComponents") or []),
                            alertCollectionError=item.get("collectionError"))
                # A recovery must be a fresh healthy run after this alert, not the pre-alert streak.
                last["success"]=0
        elif not unavailable and not component_bad:
            if alerted and last["success"]>=HEALTH_RECOVERY_CONFIRM:
                if alert_delivered(store,last):
                    recover={"instanceId":item["id"],
                             "previousComponents":list(last.get("alertComponents") or []),
                             "previousCollectionError":last.get("alertCollectionError"),
                             "alertedAt":datetime.fromtimestamp(float(last["alertedAt"]),CST).isoformat() if last.get("alertedAt") else None,
                             "successSamples":last["success"]}
                    enqueue_report(store,config,snapshot,key+":recover:"+str(last["episode"]),"恢复报告",health=recover)
                else:
                    # Nobody saw the alert, so there is nothing to recover from at 08:00 tomorrow.
                    supersede_unseen_alert(store,last)
                last["alerted"]=False
        store.put(key,last)
        # Only a successful complete ticket read may close a human issue.
        if item.get("quality")!="observed_nonatomic":
            continue
        live={i["issueId"]:i for i in item["humanItems"]}
        known=store.get("issues:"+item["id"],{})
        settle=settle_seconds(config)
        for ident,issue in live.items():
            state=known.get(ident,{"episode":0,"active":False,"revision":None,"sentKey":None,"reminders":0})
            if not state["active"]:
                # A question that becomes pending again after not being pending is a new episode.
                state["episode"]+=1
                state.update(active=True,revision=issue["revision"],sentKey=None,reminders=0,reminderDay=now.date().isoformat())
            else:
                # The same question still waits; only its snapshot moved, so it keeps its notice and reminders.
                state["revision"]=issue["revision"]
            # A notice superseded while it was still queued (the revision formula changed in this version,
            # so an in-flight notice from the previous version goes stale at dispatch) would otherwise stay
            # dead: plan only enqueues when sentKey is empty and accepted_at() never sees a superseded row.
            # Bump the episode so the retry gets a new key instead of colliding with the superseded row.
            if state.get("sentKey") and store.state_of(state["sentKey"]) in (None,"superseded"):
                state["episode"]=state.get("episode",0)+1
                state["sentKey"]=None
                state["reminders"]=0
            if state.get("reminderDay")!=now.date().isoformat():
                state.update(reminderDay=now.date().isoformat(),reminders=0)
            # The first notice waits for the ticket to stay unchanged: a person answering in the source
            # thread bumps updatedAt and restarts this window, so the notice no longer interrupts a reply.
            # An unreadable updatedAt must not silence the notice forever: fall back to the pre-settle behavior.
            updated=instant(issue.get("updatedAt")) or (now-timedelta(seconds=settle))
            if state.get("sentKey") is None and (now-min(updated,now)).total_seconds()>=settle:
                key=ident+":"+str(state["episode"])+":"+issue["revision"]
                group=enqueue_report(store,config,snapshot,key,"待人工事项",issue={"id":ident,"revision":issue["revision"],"issueId":ident,"instanceId":item["id"],"ticketId":issue.get("ticketId"),"question":issue.get("question"),"reason":issue.get("reason"),"deadline":issue.get("deadline")})
                state["sentKey"]=group+"-1"
            accepted=store.accepted_at(state["sentKey"]) if state.get("sentKey") else None
            delay=1800 if state["reminders"]==0 else 7200
            if accepted and not quiet(now,config) and state["reminders"]<3 and now.timestamp()-accepted>=delay:
                ordinal=state["reminders"]+1
                group=enqueue_report(store,config,snapshot,ident+":remind:"+str(state["episode"])+":"+state["revision"]+":"+now.date().isoformat()+":"+str(ordinal),"待人工提醒",issue={"id":ident,"revision":issue["revision"],"issueId":ident,"instanceId":item["id"],"ticketId":issue.get("ticketId"),"question":issue.get("question"),"reason":issue.get("reason"),"deadline":issue.get("deadline")})
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
            # The scheduled task runs this checkout in place: a merge to main does not take
            # effect until the tree is fast-forwarded, so surface that gap instead of letting
            # a stale tree silently keep computing alerts with older logic.
            snapshot["deployment"]=deployment_state(config.get("repo_root"))
            store.put("event_cache",cache)
            store.put("last_snapshot",snapshot)
            atomic_text(directory/"latest.json",json.dumps(snapshot,ensure_ascii=False,indent=2))
            atomic_text(directory/"latest.md",render(snapshot))
            # The full attention snapshot, so a focused 待人工事项 notice still has a full-report address.
            atomic_text(directory/"latest-attention.md",render(snapshot,"待人工事项"))
            if allow_send:
                binding(config)
                plan(store,config,snapshot,datetime.now(CST))
                dispatch(store,config,snapshot)
            heartbeat={"at":datetime.now(CST).isoformat(),"mode":"send_enabled" if allow_send else "dry-run","instances":len(snapshot["instances"]),"deployment":snapshot["deployment"],"outbox":store.stats()}
            atomic_text(directory/"heartbeat.json",json.dumps(heartbeat))
            print(json.dumps(heartbeat))
            return snapshot
        finally:
            store.close()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("command",choices=["dry-run","tick","run","status","migrate-state"])
    parser.add_argument("--config",required=True)
    parser.add_argument("--allow-send",action="store_true")
    parser.add_argument("--target",help="new state folder for migrate-state")
    parser.add_argument("--write-config",action="store_true",help="point the device config at --target")
    parser.add_argument("--keep-old",action="store_true",help="leave the previous state folder in place")
    args=parser.parse_args()
    if args.command=="dry-run" and args.allow_send:
        parser.error("dry-run cannot enable sending")
    config=load_config(args.config)
    if args.command=="migrate-state":
        if args.allow_send:
            parser.error("migrate-state cannot enable sending")
        if not args.target:
            parser.error("migrate-state requires --target")
        print(json.dumps(migrate_state(config,args.config,args.target,
                                       write_config=args.write_config,keep_old=args.keep_old),
                         ensure_ascii=False))
        return
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
