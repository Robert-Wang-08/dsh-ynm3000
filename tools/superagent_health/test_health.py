"""Behavioral checks for health evidence and reliable delivery boundaries."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from common import CST, instant, safe_text, digest, load_config
from events import fold_events
from collect import instance, report_from_detail, tickets, effort_from_detail
from delivery import send, binding_id, DeliveryError
from deploy import deployment_state
from render import chunks, render, render_attention, report_text
from store import Store
from service import quiet, next_open, plan, dispatch, enqueue_report, settle_seconds, tick, migrate_state

NOW=datetime(2026,11,12,14,0,tzinfo=CST)
def event(kind,at,seq,data=None):
    return {"type":kind,"time":at.timestamp()*1000,"seq":seq,"data":data or {}}

def sample():
    return {"windowEnd":NOW.isoformat(),"collectedAt":NOW.isoformat(),"instances":[{"id":"test","health":"reachable","quality":"observed_nonatomic","errorComponents":[],"humanItems":[],"sessions":[],"tickets":[],"todayCompleted":1,"openTickets":0,"activeManagedSessionsObserved":1,"missingSessionEvidence":0}],"dashboard":[]}

class EvidenceTests(unittest.TestCase):
    def test_response_model_overrides_request_alias_without_claiming_current(self):
        events=[event("request/context",NOW-timedelta(minutes=2),1,{"provider":"p","model":"alias"}),event("assistant/message",NOW-timedelta(minutes=1),2,{"message":{"source":{"provider":"p","model":"actual"}},"usage":{"inputTokens":10,"outputTokens":4}})]
        got=fold_events(events,"2026-11-12",NOW)
        self.assertEqual(got["lastResponse"]["model"],"actual")
        self.assertEqual(got["latestRequest"]["model"],"alias")
        self.assertIsNone(got["inFlight"])
        self.assertEqual(got["tokens"]["input"],10)

    def test_midnight_window_and_no_usage_not_free(self):
        events=[event("assistant/message",NOW.replace(hour=0)-timedelta(seconds=1),1,{"message":{"source":{"model":"old"}},"usage":{"outputTokens":99}}),event("step/start",NOW-timedelta(minutes=1),2)]
        got=fold_events(events,"2026-11-12",NOW)
        self.assertTrue(got["activeToday"])
        self.assertIsNone(got["tokens"])
        self.assertEqual(got["inFlight"]["quality"],"unmatched_persisted_step_not_live_proof")

    def test_future_event_not_counted_and_duplicate_usage_not_double(self):
        ev=event("assistant/message",NOW-timedelta(seconds=1),1,{"message":{"source":{"model":"m"}},"usage":{"outputTokens":4}})
        got=fold_events([ev,ev,event("assistant/message",NOW+timedelta(seconds=1),2,{"usage":{"outputTokens":100}})],"2026-11-12",NOW)
        self.assertEqual(got["tokens"]["output"],4)

    def test_all_time_tokens_cover_previous_days_without_double_counting(self):
        events=[event("assistant/message",NOW-timedelta(days=1),1,{"usage":{"inputTokens":10,"outputTokens":2}}),
                event("assistant/message",NOW-timedelta(minutes=1),2,{"usage":{"inputTokens":3,"outputTokens":1,"cacheReadTokens":7}}),
                event("assistant/message",NOW-timedelta(minutes=1),2,{"usage":{"inputTokens":3,"outputTokens":1,"cacheReadTokens":7}})]
        got=fold_events(events,"2026-11-12",NOW)
        self.assertEqual(got["tokens"]["input"],3)
        self.assertEqual(got["tokensAll"]["input"],13)
        self.assertEqual(got["tokensAll"]["output"],3)
        self.assertEqual(got["tokensAll"]["cacheRead"],7)
        self.assertEqual(got["usageResponsesAll"],2)

    def test_recap_has_report_provenance_and_staleness(self):
        detail={"assignments":[{"id":"attempt1","report":{"summary":"已完成接口验证","at":"2026-11-11T08:34:00Z","state":"ready"}}]}
        got=report_from_detail(detail,"t1","2026-11-12T00:00:00Z")
        self.assertIn("assignment:attempt1",got["source"])
        self.assertTrue(got["mayBeStale"])
        self.assertEqual(report_from_detail({},"t1",None)["quality"],"unavailable")

    def test_failed_ticket_request_is_not_empty_complete(self):
        with patch("collect.get",return_value=(None,"auth_401")):
            rows,error=tickets("http://localhost","open")
        self.assertEqual(error,"auth_401")

    def test_schema_drift_and_nonadvancing_pagination_are_partial(self):
        with patch("collect.get",return_value=({"items":[{"id":"1","stage":"new_unknown"}],"total":1},None)):
            self.assertEqual(tickets("http://localhost","open")[1],"ticket_schema")
        with patch("collect.get",return_value=({"items":[],"total":1,"next_offset":0},None)):
            self.assertEqual(tickets("http://localhost","open")[1],"pagination_cycle")

    def test_safe_text_redacts_key_path_and_channel_id(self):
        text=safe_text("api_key=secretvalue oc_123456789012 C:/private/folder/file.md done")
        self.assertNotIn("secretvalue",text)
        self.assertNotIn("private",text)
        self.assertNotIn("oc_",text)
        self.assertIsNone(instant("not-a-time"))
        self.assertIsNone(instant("2026-11-12T00:00:00"))

    def test_renderer_chunks_preserve_all_lines_and_limit(self):
        text="一"*8000+chr(10)+"完成"
        parts=chunks(text)
        self.assertTrue(all(len(p)<=3500 for p in parts))
        self.assertEqual("".join(p.replace(chr(10),"") for p in parts),text.replace(chr(10),""))
        self.assertIn("今日有执行事件",render(sample()))

    def test_renderer_uses_markdown_sections_and_lists(self):
        text=render(sample())
        self.assertTrue(text.startswith("# Superagent · 健康报告"))
        self.assertIn("## 【test】接口可达",text)
        self.assertIn("- 今日完成工单：1",text)
        self.assertIn("- 工单待人工：0",text)

    def test_attention_notice_states_the_decision_and_the_action(self):
        snap=sample()
        snap["instances"][0]["tickets"]=[{"id":"t1","title":"语义本体工单","stage":"person","pr":12,
            "updatedAt":"2026-11-12T13:30:00+08:00",
            "recap":{"text":"PR #12 已提交并推送（+33/-26），等你合并","quality":"worker_report_not_independently_verified"}}]
        issue={"id":"test:t1:review","issueId":"test:t1:review","revision":"r1","instanceId":"test","ticketId":"t1","question":"语义本体工单","reason":"review","deadline":None}
        text=render_attention(snap,"待人工事项",issue)
        self.assertTrue(text.startswith("# Superagent · 待人工事项"))
        self.assertIn("- 工单：**t1** 语义本体工单 · 待人工",text)
        self.assertIn("- 待决问题：是否验收这单的交付（PR #12）",text)
        self.assertIn("- 需要你做：复核 PR #12",text)
        self.assertIn("- 最后进展（worker 报告）：PR #12 已提交并推送",text)
        self.assertIn("已等待 30m",text)
        self.assertNotIn("原因：review",text)
        self.assertNotIn("- 问题：语义本体工单",text)
        self.assertIn("完整待人工事项报告",text)
        self.assertIn("latest-attention.md",text)
        self.assertIn("每 4 小时整点（09/13/17）",text)
        self.assertNotIn("## 今日用量",text)
        self.assertEqual(text,report_text(snap,"待人工事项",issue))

    def test_attention_notice_explains_each_waiting_stage(self):
        snap=sample()
        snap["instances"][0]["tickets"]=[{"id":"t1","title":"语义本体工单","stage":"person"}]
        cases={"answer":("是否继续？","在提出问题的对话"),"delivery":("语义本体工单","投递会自动重试"),
               "blocked":("语义本体工单","解除阻塞"),"failed":("语义本体工单","等你决定是否重试")}
        for reason,(question,needle) in cases.items():
            issue={"id":"test:t1:"+reason,"instanceId":"test","ticketId":"t1","question":question,"reason":reason,"deadline":None}
            text=render_attention(snap,"待人工事项",issue)
            self.assertIn("- 待决问题：",text)
            self.assertIn("- 需要你做：",text)
            self.assertIn(needle,text)
            self.assertNotIn("原因："+reason,text)

    def test_health_report_human_section_names_decision_and_action(self):
        snap=sample()
        snap["instances"][0]["tickets"]=[{"id":"t1","title":"语义本体工单","stage":"person","updatedAt":"2026-11-12T13:30:00+08:00",
            "recap":{"text":"等你决定","quality":"worker_report_not_independently_verified"}}]
        snap["instances"][0]["humanItems"]=[{"issueId":"test:t1:answer","revision":"r","ticketId":"t1","reason":"answer","question":"是否继续？","updatedAt":"2026-11-12T13:30:00+08:00"}]
        text=render(snap)
        self.assertIn("**需要管理人**",text)
        self.assertIn("  - 待决问题：是否继续？",text)
        self.assertIn("  - 需要你做：",text)
        self.assertIn("已等待 30m",text)
        self.assertNotIn("原因：answer",text)

    def test_health_report_is_not_replaced_by_attention_renderer(self):
        self.assertEqual(render(sample()),report_text(sample(),"健康报告",None))

    def test_tick_writes_full_attention_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            config={"state_dir":directory,"instances":[{"id":"test"}]}
            with patch("service.collect",return_value=sample()):
                tick(config,allow_send=False)
            text=(Path(directory)/"latest-attention.md").read_text(encoding="utf-8")
            self.assertTrue(text.startswith("# Superagent · 待人工事项"))
            self.assertIn("## 【test】接口可达",text)
            self.assertIn("## 今日用量",text)

class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(self.temp.name)
    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_dedupe_persists_across_restart(self):
        self.assertTrue(self.store.enqueue("key",{"text":"x"},100))
        self.assertFalse(self.store.enqueue("key",{"text":"x"},100))
        second=Store(self.temp.name)
        self.assertFalse(second.enqueue("key",{},100))
        second.close()

    def test_two_dispatchers_do_not_claim_same_lease(self):
        self.store.enqueue("key",{},100)
        self.assertIsNotNone(self.store.claim(101))
        second=Store(self.temp.name)
        self.assertIsNone(second.claim(102))
        second.close()

    def test_crash_after_channel_acceptance_keeps_stable_retry_key(self):
        self.store.enqueue("stable-key",{},100)
        first=self.store.claim(100)
        self.assertIsNone(self.store.claim(110))
        retry=self.store.claim(191)
        self.assertEqual(first["key"],retry["key"])
        self.assertEqual(retry["state"],"unknown_delivery")
        self.store.accepted(retry["key"],"om_receipt",192)
        self.assertIsNone(self.store.claim(999))

    def test_send_failure_retry_not_ack(self):
        self.store.enqueue("key",{},100)
        self.store.claim(101)
        self.store.failed("key","timeout",ambiguous=True,now=102)
        self.assertIsNone(self.store.accepted_at("key"))
        self.assertIsNone(self.store.claim(110))
        self.assertEqual(self.store.claim(133)["key"],"key")

    def test_permanent_failure_is_visible_and_not_retried(self):
        self.store.enqueue("key",{},100)
        self.store.claim(101)
        self.store.failed("key","auth",permanent=True,now=102)
        self.assertEqual(self.store.stats(),{"needs_attention":1})
        self.assertIsNone(self.store.claim(200))

    def test_accepted_requires_message_receipt(self):
        self.store.enqueue("key",{},100)
        with self.assertRaises(ValueError):
            self.store.accepted("key","")

class DeliveryTests(unittest.TestCase):
    def test_unconfirmed_binding_never_calls_sender(self):
        with patch("delivery.subprocess.run") as run:
            with self.assertRaises(DeliveryError):
                send({"delivery":{"enabled":False}},"message","key",runner=run)
            run.assert_not_called()

    def test_bot_stdout_ok_and_idempotency_key(self):
        result=subprocess.CompletedProcess([],0,json.dumps({"ok":True,"data":{"message_id":"om_r"}}),"")
        with patch("delivery.binding",return_value=("oc_target","cli","configdir")):
            with patch("delivery.subprocess.run",return_value=result) as run:
                self.assertEqual(send({},"private body","stable-key",runner=run),"om_r")
                argv=run.call_args.args[0]
                self.assertIn("--idempotency-key",argv)
                self.assertIn("--markdown",argv)
                self.assertNotIn("--text",argv)
                self.assertNotIn("private body",argv)
                self.assertEqual(run.call_args.kwargs["input"],"private body")

    def test_timeout_is_ambiguous_not_success(self):
        with patch("delivery.binding",return_value=("oc_target","cli","configdir")):
            with patch("delivery.subprocess.run",side_effect=subprocess.TimeoutExpired("cli",30)) as run:
                with self.assertRaises(DeliveryError) as cm:
                    send({},"body","key",runner=run)
                self.assertTrue(cm.exception.ambiguous)

    def test_exit_zero_without_receipt_is_ambiguous(self):
        result=subprocess.CompletedProcess([],0,'{"ok":true,"data":{}}',"")
        with patch("delivery.binding",return_value=("oc_target","cli","configdir")):
            with self.assertRaises(DeliveryError) as cm:
                send({},"body","key",runner=lambda *a,**k:result)
            self.assertTrue(cm.exception.ambiguous)

class ScheduleTests(unittest.TestCase):
    def test_quiet_hours_and_deferred_morning(self):
        night=NOW.replace(hour=23)
        self.assertTrue(quiet(night,{}))
        morning=datetime.fromtimestamp(next_open(night,{}),CST)
        self.assertEqual(morning.day,13)
        self.assertEqual(morning.hour,8)
        self.assertFalse(quiet(NOW,{}))

    def test_repeated_tick_enqueues_startup_only_once(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            snap=sample()
            with patch("service.binding",return_value=("oc_target","cli","configdir")):
                plan(store,{"instances":[{"id":"test"}]},snap,NOW)
                first=store.stats()
                with patch("service.collect",return_value=snap):
                    store.put("closed:"+(NOW-timedelta(days=1)).date().isoformat(),{"already":True})
                    plan(store,{"instances":[{"id":"test"}]},snap,NOW+timedelta(seconds=1))
                self.assertEqual(first,store.stats())
            store.close()

    def test_default_schedule_reports_every_four_hours(self):
        # The device config may override schedule_hours; the shipped default must be 09/13/17.
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            store.put("last_plan_at",NOW.replace(hour=12,minute=0).isoformat())
            store.put("closed:"+(NOW-timedelta(days=1)).date().isoformat(),{"already":True})
            snap=sample()
            def scheduled():
                return sum(1 for row in store.db.execute("SELECT payload FROM outbox")
                           if json.loads(row["payload"]).get("kind")=="定期健康报告")
            with patch("service.binding",return_value=("oc_target","cli","configdir")):
                plan(store,{"instances":[{"id":"test"}]},snap,NOW.replace(hour=13,minute=1))
                self.assertEqual(scheduled(),1)
                plan(store,{"instances":[{"id":"test"}]},snap,NOW.replace(hour=15,minute=1))
                self.assertEqual(scheduled(),1)
                plan(store,{"instances":[{"id":"test"}]},snap,NOW.replace(hour=17,minute=1))
                self.assertEqual(scheduled(),2)
            store.close()

class AttentionTimingTests(unittest.TestCase):
    """A pending question is announced only after the ticket has been quiet for a while."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(self.temp.name)
        self.store.put("last_plan_at",(NOW-timedelta(minutes=1)).isoformat())
        self.store.put("closed:"+(NOW-timedelta(days=1)).date().isoformat(),{"already":True})
    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def snapshot(self, updated_at, issue=True):
        snap=sample()
        snap["instances"][0]["humanItems"]=[{"issueId":"test:t1:attention-1","revision":digest(["attention-1"]),
            "ticketId":"t1","reason":"answer","question":"是否继续？","updatedAt":updated_at.isoformat()}] if issue else []
        return snap

    def plan_at(self, snap, at, settle=180, **config):
        # A short window keeps the offsets readable; the 15-minute default is asserted on its own.
        extra={} if settle is None else {"attention_settle_seconds":settle}
        with patch("service.binding",return_value=("oc_target","cli","configdir")):
            plan(self.store,{"instances":[{"id":"test"}],**extra,**config},snap,at)

    def notices(self, kind="待人工事项"):
        rows=self.store.db.execute("SELECT payload FROM outbox").fetchall()
        return [payload for row in rows for payload in [json.loads(row["payload"])] if payload.get("kind")==kind]

    def test_first_notice_waits_for_the_settle_window(self):
        snap=self.snapshot(NOW)
        self.plan_at(snap,NOW+timedelta(seconds=120))
        self.assertEqual(self.notices(),[])
        self.plan_at(snap,NOW+timedelta(seconds=185))
        self.assertEqual(len(self.notices()),1)

    def test_a_reply_restarts_the_window_instead_of_alerting(self):
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=120))
        replied=self.snapshot(NOW+timedelta(seconds=100))
        self.plan_at(replied,NOW+timedelta(seconds=200))
        self.assertEqual(self.notices(),[])
        self.plan_at(replied,NOW+timedelta(seconds=290))
        self.assertEqual(len(self.notices()),1)

    def test_question_resolved_within_the_window_sends_nothing(self):
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=60))
        self.plan_at(self.snapshot(NOW,issue=False),NOW+timedelta(seconds=240))
        self.assertEqual(self.notices(),[])

    def test_old_pending_question_is_notified_on_first_sighting(self):
        self.plan_at(self.snapshot(NOW-timedelta(minutes=10)),NOW)
        self.assertEqual(len(self.notices()),1)

    def test_updating_the_ticket_does_not_repeat_the_same_question(self):
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=200))
        self.assertEqual(len(self.notices()),1)
        self.plan_at(self.snapshot(NOW+timedelta(seconds=300)),NOW+timedelta(seconds=400))
        self.assertEqual(len(self.notices()),1)

    def test_new_question_after_the_first_notice_is_announced(self):
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=200))
        self.assertEqual(len(self.notices()),1)
        snap=sample()
        snap["instances"][0]["humanItems"]=[{"issueId":"test:t1:attention-2","revision":digest(["attention-2"]),
            "ticketId":"t1","reason":"answer","question":"下一步？","updatedAt":(NOW+timedelta(seconds=210)).isoformat()}]
        self.plan_at(snap,NOW+timedelta(seconds=300))
        self.assertEqual(len(self.notices()),1)
        self.plan_at(snap,NOW+timedelta(seconds=400))
        self.assertEqual(len(self.notices()),2)

    def test_settle_follows_configuration(self):
        self.assertEqual(settle_seconds({}),900)
        self.assertEqual(settle_seconds({"attention_settle_seconds":0}),0)
        self.assertEqual(settle_seconds({"attention_settle_seconds":"not-a-number"}),900)
        self.assertEqual(settle_seconds({"attention_settle_seconds":-5}),0)
        self.assertEqual(settle_seconds({"attention_settle_seconds":15*60}),900)
        self.plan_at(self.snapshot(NOW),NOW,attention_settle_seconds=0)
        self.assertEqual(len(self.notices()),1)

    def test_default_window_is_fifteen_minutes(self):
        snap=self.snapshot(NOW)
        self.plan_at(snap,NOW+timedelta(seconds=899),settle=None)
        self.assertEqual(self.notices(),[])
        self.plan_at(snap,NOW+timedelta(seconds=901),settle=None)
        self.assertEqual(len(self.notices()),1)

    def test_legacy_state_keeps_the_same_question_quiet(self):
        # States written before the settle window carry an older revision for the same waiting question.
        self.store.enqueue("legacy-notice",{"text":"x"},now=1)
        self.store.accepted("legacy-notice","om_old",now=(NOW+timedelta(seconds=10)).timestamp())
        self.store.put("issues:test",{"test:t1:attention-1":{"episode":1,"active":True,"revision":"legacy","sentKey":"legacy-notice","reminders":0,"reminderDay":NOW.date().isoformat()}})
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=300))
        self.assertEqual(self.notices(),[])

    def test_superseded_notice_is_rearmed_instead_of_staying_dead(self):
        # A notice queued before the revision formula changed is superseded at dispatch; plan must re-arm it.
        self.store.enqueue("legacy-notice",{"text":"x","kind":"待人工事项"},now=1)
        with self.store.db:
            self.store.db.execute("UPDATE outbox SET state='superseded' WHERE key='legacy-notice'")
        self.store.put("issues:test",{"test:t1:attention-1":{"episode":1,"active":True,"revision":digest(["attention-1"]),"sentKey":"legacy-notice","reminders":0,"reminderDay":NOW.date().isoformat()}})
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=200))
        pending=self.store.db.execute("SELECT count(*) FROM outbox WHERE state='pending' AND payload LIKE '%待人工事项%'").fetchone()[0]
        self.assertEqual(pending,1)
        state=self.store.get("issues:test")["test:t1:attention-1"]
        self.assertNotEqual(state["sentKey"],"legacy-notice")
        self.assertEqual(state["episode"],2)

    def test_upgrade_dispatch_supersedes_then_plan_rearms(self):
        # End-to-end upgrade path: an in-flight notice written with the previous revision formula goes
        # stale at dispatch (no send), and the next plan turns it into a fresh queued notice.
        cfg={"instances":[{"id":"test"}]}
        snap_old=self.snapshot(NOW)
        snap_old["instances"][0]["humanItems"][0]["revision"]="legacy-revision"
        with patch("service.binding",return_value=("oc_target","cli","configdir")), patch("service.send") as sender:
            group=enqueue_report(self.store,cfg,snap_old,"test:t1:attention-1:1:legacy","待人工事项",
                issue={"id":"test:t1:attention-1","revision":"legacy-revision","instanceId":"test"})
            self.store.put("issues:test",{"test:t1:attention-1":{"episode":1,"active":True,"revision":"legacy-revision","sentKey":group+"-1","reminders":0,"reminderDay":NOW.date().isoformat()}})
            dispatch(self.store,cfg,self.snapshot(NOW))
            self.assertEqual(sender.call_count,0)
            self.assertEqual(self.store.state_of(group+"-1"),"superseded")
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=200))
        pending=self.store.db.execute("SELECT count(*) FROM outbox WHERE state='pending' AND payload LIKE '%待人工事项%'").fetchone()[0]
        self.assertEqual(pending,1)
        state=self.store.get("issues:test")["test:t1:attention-1"]
        self.assertNotEqual(state["sentKey"],group+"-1")
        self.assertEqual(state["episode"],2)

    def test_missing_updated_at_still_notifies(self):
        # An unparseable updatedAt must fall back to the pre-settle behavior instead of waiting forever.
        snap=self.snapshot(NOW)
        del snap["instances"][0]["humanItems"][0]["updatedAt"]
        self.plan_at(snap,NOW+timedelta(seconds=200))
        self.assertEqual(len(self.notices()),1)

    def test_reminder_still_follows_an_accepted_notice(self):
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=200))
        row=self.store.db.execute("SELECT key FROM outbox WHERE state='pending'").fetchone()
        self.store.accepted(row["key"],"om_receipt",now=(NOW+timedelta(seconds=200)).timestamp())
        self.plan_at(self.snapshot(NOW),NOW+timedelta(minutes=35))
        self.assertEqual(len(self.notices("待人工提醒")),1)


class HealthAlertTests(unittest.TestCase):
    """A flapping component must not page on every sample, and an incident stays a short message."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(self.temp.name)
        self.store.put("last_plan_at",(NOW-timedelta(minutes=1)).isoformat())
        self.store.put("closed:"+(NOW-timedelta(days=1)).date().isoformat(),{"already":True})
    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def snapshot(self,components=(),health=None,collection_error=None):
        snap=sample()
        item=snap["instances"][0]
        item.update(health=health or ("online_degraded" if components else "reachable"),
                    errorComponents=list(components),collectionError=collection_error)
        item["components"]={name:{"state":"error","code":"pollFailures","at":NOW.isoformat(),
                                   "detail":"3 consecutive failed polls; last: network"} for name in components}
        return snap

    def plan_at(self,snap,at):
        snap=dict(snap)
        snap["windowEnd"]=snap["collectedAt"]=at.isoformat()
        with patch("service.binding",return_value=("oc_target","cli","configdir")):
            plan(self.store,{"instances":[{"id":"test"}]},snap,at)

    def messages(self,kind=None):
        rows=self.store.db.execute("SELECT payload FROM outbox").fetchall()
        payloads=[json.loads(row["payload"]) for row in rows]
        return [payload for payload in payloads if kind is None or payload.get("kind")==kind]

    def accept_alerts(self,at):
        with self.store.db:
            self.store.db.execute("UPDATE outbox SET state='channel_accepted',accepted=? WHERE payload LIKE ?",
                                  (at.timestamp(),'%异常健康报告%'))

    def test_component_alert_waits_for_confirmation_and_stays_compact(self):
        snap=self.snapshot(["github"])
        self.plan_at(snap,NOW+timedelta(minutes=1))
        self.plan_at(snap,NOW+timedelta(minutes=2))
        self.assertEqual(self.messages("异常健康报告"),[])
        self.plan_at(snap,NOW+timedelta(minutes=3))
        alerts=self.messages("异常健康报告")
        self.assertEqual(len(alerts),1)
        text=alerts[0]["text"]
        self.assertIn("**异常说明**",text)
        self.assertIn("github",text)
        self.assertIn("轮询连续失败",text)
        self.assertIn("最近错误",text)
        self.assertNotIn("**会话**",text)
        self.assertNotIn("**工单**",text)
        self.assertNotIn("**任务投入**",text)

    def test_transient_component_error_sends_nothing(self):
        snap=self.snapshot(["github"])
        self.plan_at(snap,NOW+timedelta(minutes=1))
        self.plan_at(snap,NOW+timedelta(minutes=2))
        healthy=self.snapshot()
        for offset in range(3,6):
            self.plan_at(healthy,NOW+timedelta(minutes=offset))
        self.assertEqual(self.messages(),[])

    def test_collection_outage_keeps_its_three_failure_confirmation(self):
        down=self.snapshot(health="unknown",collection_error="transport_or_schema")
        self.plan_at(down,NOW+timedelta(minutes=1))
        self.plan_at(down,NOW+timedelta(minutes=2))
        self.assertEqual(self.messages("异常健康报告"),[])
        self.plan_at(down,NOW+timedelta(minutes=3))
        text=self.messages("异常健康报告")[0]["text"]
        self.assertIn("采集失败",text)
        self.assertIn("transport_or_schema",text)

    def test_recovery_after_a_collection_outage_names_the_collection_failure(self):
        down=self.snapshot(health="unknown",collection_error="transport_or_schema")
        for offset in range(3):
            self.plan_at(down,NOW+timedelta(minutes=offset))
        self.accept_alerts(NOW+timedelta(minutes=2))
        for offset in range(3,6):
            self.plan_at(self.snapshot(),NOW+timedelta(minutes=offset))
        recoveries=self.messages("恢复报告")
        self.assertEqual(len(recoveries),1)
        self.assertIn("采集失败 transport_or_schema 已恢复",recoveries[0]["text"])

    def test_recovery_names_time_and_cause_without_the_full_inventory(self):
        snap=self.snapshot(["github"])
        snap["instances"][0]["sessions"]=[{"id":"worker-1","role":"worker","events":{}}]
        snap["instances"][0]["tickets"]=[{"id":"t1","title":"语义本体工单","stage":"ended",
                                          "recap":{"text":"完成","quality":"x"},"effort":None}]
        snap["instances"][0]["taskEffort"]=[{"ticketId":"t1","title":"语义本体工单","outcome":"completed",
                                             "elapsedSeconds":60,"inputRounds":1,"handoffRounds":1,
                                             "tokens":{"input":1,"output":1}}]
        for offset in range(3):
            self.plan_at(snap,NOW+timedelta(minutes=offset))
        self.accept_alerts(NOW+timedelta(minutes=2))
        healthy=self.snapshot()
        for offset in range(3,6):
            self.plan_at(healthy,NOW+timedelta(minutes=offset))
        recoveries=self.messages("恢复报告")
        self.assertEqual(len(recoveries),1)
        text=recoveries[0]["text"]
        self.assertIn("**恢复时点**",text)
        self.assertIn("github",text)
        self.assertIn("**原因说明**",text)
        self.assertIn("连续 3 次采集成功",text)
        self.assertNotIn("**会话**",text)
        self.assertNotIn("**工单**",text)
        self.assertNotIn("**任务投入**",text)
        self.assertNotIn("语义本体工单",text)

    def test_a_single_green_sample_after_a_long_outage_does_not_recover(self):
        # Degraded samples must not count toward the recovery streak: otherwise the first green
        # sample would satisfy it after any outage longer than the confirmation window.
        snap=self.snapshot(["github"])
        for offset in range(3):
            self.plan_at(snap,NOW+timedelta(minutes=offset))
        self.accept_alerts(NOW+timedelta(minutes=2))
        for offset in range(3,9):
            self.plan_at(snap,NOW+timedelta(minutes=offset))
        self.plan_at(self.snapshot(),NOW+timedelta(minutes=9))
        self.assertEqual(self.messages("恢复报告"),[])
        for offset in range(10,12):
            self.plan_at(self.snapshot(),NOW+timedelta(minutes=offset))
        self.assertEqual(len(self.messages("恢复报告")),1)

    def test_queued_alert_is_dropped_instead_of_being_followed_by_a_recovery(self):
        # A component error during quiet hours would otherwise deliver alert and recovery together at 08:00.
        night=NOW.replace(hour=23)
        self.store.put("last_plan_at",(night-timedelta(minutes=1)).isoformat())
        snap=self.snapshot(["github"])
        for offset in range(3):
            self.plan_at(snap,night+timedelta(minutes=offset))
        self.assertEqual(len(self.messages("异常健康报告")),1)
        healthy=self.snapshot()
        for offset in range(3,6):
            self.plan_at(healthy,night+timedelta(minutes=offset))
        states=dict(self.store.db.execute("SELECT key,state FROM outbox").fetchall())
        self.assertTrue(states)
        self.assertTrue(all(state=="superseded" for state in states.values()))
        self.assertEqual(self.messages("恢复报告"),[])

    def test_delivered_alert_is_not_repeated_inside_the_cooldown(self):
        snap=self.snapshot(["github"])
        for offset in range(3):
            self.plan_at(snap,NOW+timedelta(minutes=offset))
        self.assertEqual(len(self.messages("异常健康报告")),1)
        self.accept_alerts(NOW+timedelta(minutes=2))
        healthy=self.snapshot()
        for offset in range(3,6):
            self.plan_at(healthy,NOW+timedelta(minutes=offset))
        self.assertEqual(len(self.messages("恢复报告")),1)
        changed=self.snapshot(["history"])
        for offset in range(7,10):
            self.plan_at(changed,NOW+timedelta(minutes=offset))
        self.assertEqual(len(self.messages("异常健康报告")),1)
        for offset in range(19,22):
            self.plan_at(changed,NOW+timedelta(minutes=offset))
        self.assertEqual(len(self.messages("异常健康报告")),2)


class HumanItemIdentityTests(unittest.TestCase):
    """Collecting a ticket that merely changed must not turn the same pending question into a new alert."""
    def test_updated_ticket_keeps_revision_and_exposes_activity_time(self):
        items=[{"id":"t1","title":"语义本体工单","stage":"person","action":"answer","updatedAt":"2026-11-12T06:00:00Z"}]
        state={"health":{"api":{"state":"ok"}},"masterId":"master-1"}
        class Reader:
            def read(self,sid,day,now): return {}
        def fake_get(url,attempts=1):
            if url.endswith("/state"): return state,None
            if "/tickets?state=open" in url: return {"items":items,"total":1,"next_offset":None},None
            if "/tickets?state=ended" in url: return {"items":[],"total":0,"next_offset":None},None
            if url.endswith("/tickets/t1"): return {"attention":{"id":"attention-1","question":"是否继续？"},"pr_number":12},None
            return None,"http_404"
        with patch("collect.get",side_effect=fake_get):
            first=instance({},{"id":"test","url":"http://127.0.0.1:3082"},NOW,Reader())
            items[0]["updatedAt"]="2026-11-12T06:03:00Z"
            second=instance({},{"id":"test","url":"http://127.0.0.1:3082"},NOW,Reader())
        before,after=first["humanItems"][0],second["humanItems"][0]
        self.assertEqual(before["revision"],after["revision"])
        self.assertEqual(before["updatedAt"],"2026-11-12T06:00:00Z")
        self.assertEqual(after["updatedAt"],"2026-11-12T06:03:00Z")
        self.assertEqual(first["tickets"][0]["pr"],12)


class TaskEffortTests(unittest.TestCase):
    """A finished task keeps its input rounds, handoffs and elapsed time for the effort ranking."""
    class Reader:
        def __init__(self, events=None): self.events=events or {}
        def read(self,sid,day,now): return self.events

    def collect(self, items, detail, now=NOW, events=None):
        def fake_get(url,attempts=1):
            if url.endswith("/state"): return {"health":{"api":{"state":"ok"}},"masterId":"master-1"},None
            if "/tickets?state=open" in url: return {"items":[],"total":0,"next_offset":None},None
            if "/tickets?state=ended" in url: return {"items":items,"total":len(items),"next_offset":None},None
            if "/tickets/" in url:
                ticket_id=url.rsplit("/",1)[-1]
                return (detail(ticket_id) if callable(detail) else detail),None
            return None,"http_404"
        with patch("collect.get",side_effect=fake_get):
            return instance({},{"id":"test","url":"http://127.0.0.1:3082"},now,self.Reader(events))

    def items(self, ended_at="2026-11-12T06:00:00Z", created_at="2026-11-12T03:00:00Z"):
        return [{"id":"t1","title":"任务一","stage":"ended","ended":{"at":ended_at,"outcome":"completed"},"createdAt":created_at,"sessionId":"worker-t1"}]

    def detail(self, created_at="2026-11-12T03:00:00Z", ended_at="2026-11-12T06:00:00Z"):
        return {"createdAt":created_at,"ended":{"at":ended_at},"assignments":[{"id":"a1","state":"ended"},{"id":"a2","state":"ended"}],
                "decision":{"kind":"accept","triggerIds":["z"]},
                "inputs":[{"kind":"trigger","triggerId":"x","human":True},{"kind":"resumed","triggerId":"x"},
                          {"kind":"trigger","triggerId":"y","human":True},{"kind":"note","text":"补充"}]}

    def test_finished_task_counts_distinct_inputs_handoffs_and_elapsed_time(self):
        got=self.collect(self.items(),self.detail())
        task=got["taskEffort"][0]
        self.assertEqual(task["ticketId"],"t1")
        self.assertEqual(task["outcome"],"completed")
        # x, y follow-ups and z, the trigger that created the ticket; the resumed copy of x is not a new round.
        self.assertEqual(task["inputRounds"],3)
        self.assertEqual(task["handoffRounds"],2)
        self.assertEqual(task["elapsedSeconds"],3*3600)
        self.assertEqual(got["taskEffortTotal"],1)
        self.assertEqual(got["taskEffortMissing"],0)

    def test_finished_task_keeps_worker_session_token_usage(self):
        usage={"tokensAll":{"input":1000,"output":200,"cacheRead":5000,"cacheWrite":0},"responsesWithoutUsageAll":0}
        got=self.collect(self.items(),self.detail(),events=usage)
        task=got["taskEffort"][0]
        self.assertEqual(task["tokens"],{"input":1000,"output":200,"cacheRead":5000,"cacheWrite":0})
        self.assertEqual(task["tokenQuality"],"complete")
        self.assertEqual(got["taskTokenTotal"]["cacheRead"],5000)
        self.assertEqual((got["taskTokenTasks"],got["taskTokenMissing"]),(1,0))

    def test_missing_usage_stays_unknown_instead_of_zero(self):
        got=self.collect(self.items(),self.detail())
        task=got["taskEffort"][0]
        self.assertIsNone(task["tokens"])
        self.assertEqual(task["tokenQuality"],"unavailable")
        self.assertIsNone(got["taskTokenTotal"])
        snap=sample()
        snap["instances"]=[got]
        text=render(snap)
        self.assertIn("token 未知",text)
        self.assertNotIn("token 入 0",text)

    def test_partial_usage_is_marked_on_the_task_line(self):
        usage={"tokensAll":{"input":10,"output":2,"cacheRead":0,"cacheWrite":0},"responsesWithoutUsageAll":3}
        got=self.collect(self.items(),self.detail(),events=usage)
        self.assertEqual(got["taskEffort"][0]["tokenQuality"],"partial")
        snap=sample()
        snap["instances"]=[got]
        self.assertIn("（部分响应无usage）",render(snap))

    def test_effort_ranking_is_window_scoped(self):
        # An older ticket still active today is listed as a ticket, but yesterday's task is not today's effort.
        got=self.collect(self.items(ended_at="2026-11-11T06:00:00Z",created_at="2026-11-11T03:00:00Z"),
                         self.detail(created_at="2026-11-11T03:00:00Z",ended_at="2026-11-11T06:00:00Z"),
                         events={"activeToday":True,"quality":"observed"})
        self.assertEqual(got["taskEffort"],[])
        self.assertEqual(got["taskEffortMissing"],0)

    def test_unreadable_detail_marks_effort_missing_instead_of_zero(self):
        def fake_get(url,attempts=1):
            if url.endswith("/state"): return {"health":{"api":{"state":"ok"}},"masterId":"master-1"},None
            if "/tickets?state=open" in url: return {"items":[],"total":0,"next_offset":None},None
            if "/tickets?state=ended" in url: return {"items":self.items(),"total":1,"next_offset":None},None
            return None,"transport_or_schema"
        with patch("collect.get",side_effect=fake_get):
            got=instance({},{"id":"test","url":"http://127.0.0.1:3082"},NOW,self.Reader())
        self.assertEqual(got["taskEffort"],[])
        self.assertEqual(got["taskEffortMissing"],1)
        snap=sample()
        snap["instances"]=[got]
        text=render(snap)
        self.assertIn("任务投入",text)
        self.assertIn("缺少可核验详情",text)
        self.assertNotIn("输入 0 轮",text)

    def test_creation_trigger_counts_as_the_first_round(self):
        detail={"createdAt":"2026-11-12T03:00:00Z","assignments":[],"inputs":[],"decision":{"triggerIds":["z"]}}
        got=effort_from_detail(detail,{"ended":{"at":"2026-11-12T06:00:00Z"}},NOW)
        self.assertEqual(got["inputRounds"],1)

    def test_impossible_time_range_is_not_reported_as_a_number(self):
        detail={"createdAt":"2026-11-12T08:00:00Z","inputs":[],"assignments":[]}
        self.assertEqual(effort_from_detail(detail,{"ended":{"at":"2026-11-12T06:00:00Z"}},NOW)["quality"],"unavailable")
        detail={"createdAt":"2026-11-12T05:00:00Z","inputs":[],"assignments":[]}
        self.assertEqual(effort_from_detail(detail,{"ended":{"at":"2026-11-12T07:00:00Z"}},NOW)["quality"],"unavailable")

    def test_ranking_puts_the_longest_task_first(self):
        items=[{"id":"t1","title":"长任务","stage":"ended","ended":{"at":"2026-11-12T06:00:00Z","outcome":"completed"},"createdAt":"2026-11-12T03:00:00Z"},
               {"id":"t2","title":"短任务","stage":"ended","ended":{"at":"2026-11-12T05:00:00Z","outcome":"stopped"},"createdAt":"2026-11-12T04:00:00Z"}]
        details={"t1":self.detail(), "t2":self.detail(created_at="2026-11-12T04:00:00Z",ended_at="2026-11-12T05:00:00Z")}
        got=self.collect(items,lambda ticket_id:details[ticket_id])
        self.assertEqual([task["ticketId"] for task in got["taskEffort"]],["t1","t2"])
        self.assertEqual([task["elapsedSeconds"] for task in got["taskEffort"]],[3*3600,3600])

    def test_render_orders_tasks_by_descending_duration(self):
        snap=sample()
        snap["instances"][0]["taskEffort"]=[
            {"ticketId":"b"*32,"title":"长任务","outcome":"stopped","inputRounds":5,"handoffRounds":4,"elapsedSeconds":3660,
             "tokens":{"input":2000,"output":100,"cacheRead":0,"cacheWrite":0},"tokenQuality":"complete"},
            {"ticketId":"a"*32,"title":"短任务","outcome":"completed","inputRounds":1,"handoffRounds":1,"elapsedSeconds":90,
             "tokens":{"input":500,"output":50,"cacheRead":0,"cacheWrite":0},"tokenQuality":"complete"}]
        snap["instances"][0]["taskEffortTotal"]=2
        snap["instances"][0]["taskTokenTotal"]={"input":2500,"output":150,"cacheRead":0,"cacheWrite":0}
        snap["instances"][0]["taskTokenTasks"]=2
        snap["instances"][0]["taskTokenMissing"]=0
        text=render(snap)
        self.assertIn("任务投入（本窗口结束，按运行时长排序）",text)
        self.assertLess(text.index("长任务"),text.index("短任务"))
        self.assertIn(" · 已停止 · 输入 5 轮 / 交手 4 次 · 运行 1h1m · token 入 2.0k / 出 100",text)
        self.assertIn("运行 1m",text)
        self.assertIn("本窗口结束任务合计 token 入 2.5k / 出 150（2 项有 usage）",text)


class DispatchBoundaryTests(unittest.TestCase):
    def test_binding_change_never_sends_old_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            store.enqueue("old",{"text":"x","expires":9999999999,"bindingHash":digest("old"),"urgent":False},now=1)
            with patch("service.binding",return_value=("new","cli","directory")), patch("service.quiet",return_value=False), patch("service.send") as sender:
                dispatch(store,{},sample())
                sender.assert_not_called()
            self.assertEqual(store.stats(),{"needs_attention":1})
            store.close()

    def test_retry_during_quiet_hours_is_deferred(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            store.enqueue("night",{"text":"x","expires":9999999999,"bindingHash":digest("same"),"urgent":False},now=1)
            with patch("service.binding",return_value=("same","cli","directory")), patch("service.quiet",return_value=True), patch("service.next_open",return_value=9999999999), patch("service.send") as sender:
                dispatch(store,{},sample())
                sender.assert_not_called()
            self.assertEqual(store.stats(),{"retry_wait":1})
            store.close()

    def test_closed_window_keeps_real_collection_time_and_delays_to_nine(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            at=NOW.replace(hour=0,minute=10)
            store.put("last_plan_at",at.replace(minute=9).isoformat())
            snap=sample()
            snap["collectedAt"]=at.isoformat()
            with patch("service.binding",return_value=("same","cli","directory")), patch("service.collect",return_value=snap) as collector:
                plan(store,{"instances":[{"id":"test"}]},snap,at)
                self.assertEqual(snap["collectedAt"],at.isoformat())
                self.assertEqual(collector.call_args.kwargs["window_end"].day,11)
                rows=store.db.execute("SELECT available FROM outbox").fetchall()
                self.assertTrue(all(datetime.fromtimestamp(r[0],CST).hour==9 for r in rows))
            store.close()

class GroupAndRevisionTests(unittest.TestCase):
    def test_multipart_serialization_failure_rolls_back_whole_report(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            with self.assertRaises(TypeError):
                store.enqueue_group([("page1",{"text":"first"}),("page2",{"cannotEncode":object()})],100,created=99)
            self.assertEqual(store.stats(),{})
            store.close()

    def test_retry_does_not_mix_new_pages_into_existing_report(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            self.assertTrue(store.enqueue_group([("group-1",{"text":"original"})],100,created=99))
            self.assertFalse(store.enqueue_group([("group-1",{"text":"new"}),("group-2",{"text":"extra"})],100,created=99))
            rows=store.db.execute("SELECT key,payload FROM outbox").fetchall()
            self.assertEqual(len(rows),1)
            self.assertEqual(json.loads(rows[0]["payload"])["text"],"original")
            store.close()

    def test_changed_issue_revision_supersedes_old_reminder(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            config={}
            resolved=("same","cli","directory")
            payload={"text":"outdated","expires":9999999999,"urgent":False,"bindingHash":binding_id(config,resolved),"issue":{"id":"issue1","revision":"old","instanceId":"test"}}
            store.enqueue("notice",payload,now=1)
            snap=sample()
            snap["instances"][0]["humanItems"]=[{"issueId":"issue1","revision":"new"}]
            snap["instances"].append({"id":"other","quality":"unavailable"})
            with patch("service.binding",return_value=resolved),patch("service.quiet",return_value=False),patch("service.send") as sender:
                dispatch(store,config,snap)
                sender.assert_not_called()
            self.assertEqual(store.stats(),{"superseded":1})
            store.close()

    def test_source_failure_does_not_treat_missing_issue_as_resolved(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            resolved=("same","cli","directory")
            payload={"text":"known pending issue","expires":9999999999,"urgent":False,"bindingHash":binding_id({},resolved),"issue":{"id":"issue1","revision":"old","instanceId":"test"}}
            store.enqueue("notice",payload,now=1)
            snap=sample()
            snap["instances"][0]["quality"]="unavailable"
            with patch("service.binding",return_value=resolved),patch("service.quiet",return_value=False),patch("service.send",return_value="om_receipt") as sender:
                dispatch(store,{},snap)
                sender.assert_called_once()
            self.assertEqual(store.stats(),{"channel_accepted":1})
            store.close()

    def test_same_chat_with_changed_bot_configuration_is_not_same_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            config={"delivery":{"identity":"bot","content_policy":"redacted_health_report_v1"}}
            old=("same-chat","cli","bot-A-directory")
            new=("same-chat","cli","bot-B-directory")
            store.enqueue("old",{"text":"x","expires":9999999999,"urgent":False,"bindingHash":binding_id(config,old)},now=1)
            with patch("service.binding",return_value=new),patch("service.quiet",return_value=False),patch("service.send") as sender:
                dispatch(store,config,sample())
                sender.assert_not_called()
            self.assertEqual(store.stats(),{"needs_attention":1})
            store.close()

class _GitResult:
    def __init__(self,stdout="",returncode=0,stderr=""):
        self.stdout,self.stderr,self.returncode=stdout,stderr,returncode

def fake_git(answers):
    calls=[]
    def runner(argv,**kwargs):
        calls.append(" ".join(argv[3:]))
        value=answers.get(" ".join(argv[3:]))
        if isinstance(value,_GitResult):
            return value
        if value is None:
            return _GitResult("",1,"missing")
        return _GitResult(value)
    runner.calls=calls
    return runner

class DeploymentGuardTests(unittest.TestCase):
    """The scheduled task runs this checkout in place, so a merge is not live until it is fast-forwarded."""
    def state(self,**overrides):
        answers={"rev-parse --abbrev-ref HEAD":"main",
                 "rev-parse HEAD":"a"*40,
                 "rev-parse --verify origin/main":"a"*40,
                 "rev-list --count --left-right origin/main...HEAD":"0\t0",
                 "status --porcelain -- .":""}
        answers.update(overrides)
        return deployment_state(Path("C:/repo"),runner=fake_git(answers))

    def test_main_tip_is_reported_without_a_warning(self):
        state=self.state()
        self.assertEqual(state["quality"],"observed")
        self.assertTrue(state["current"])
        snap=sample()
        snap["deployment"]=state
        text=render(snap)
        self.assertIn("运行代码 main@aaaaaaaaaaaa",text)
        self.assertNotIn("部署警告",text)

    def test_a_tree_behind_main_warns_with_the_fast_forward_step(self):
        state=self.state(**{"rev-parse HEAD":"b"*40,
                            "rev-list --count --left-right origin/main...HEAD":"2\t0"})
        self.assertFalse(state["current"])
        self.assertEqual(state["behind"],2)
        self.assertIn("behind",state["reasons"])
        snap=sample()
        snap["deployment"]=state
        text=render(snap)
        self.assertIn("**部署警告**",text)
        self.assertIn("落后 main 2 个提交",text)
        self.assertIn("git merge --ff-only origin/main",text)

    def test_a_feature_branch_is_not_a_deployment(self):
        state=self.state(**{"rev-parse --abbrev-ref HEAD":"agent/fix",
                            "rev-parse HEAD":"b"*40,
                            "rev-list --count --left-right origin/main...HEAD":"0\t1"})
        self.assertFalse(state["current"])
        self.assertIn("branch",state["reasons"])
        self.assertIn("ahead",state["reasons"])
        snap=sample()
        snap["deployment"]=state
        text=render(snap)
        self.assertIn("在分支 agent/fix 上",text)
        self.assertIn("领先 main 1 个提交",text)

    def test_missing_remote_ref_falls_back_to_the_local_branch(self):
        state=self.state(**{"rev-parse --verify origin/main":_GitResult("",1,"no such ref"),
                            "rev-parse --verify main":"a"*40,
                            "rev-list --count --left-right main...HEAD":"0\t0"})
        self.assertEqual(state["quality"],"observed")
        self.assertTrue(state["current"])

    def test_uncommitted_tool_changes_are_not_the_main_version(self):
        state=self.state(**{"status --porcelain -- .":" M tools/superagent_health/service.py\n?? tools/superagent_health/extra.py\n"})
        self.assertFalse(state["current"])
        self.assertEqual(state["reasons"],["dirty"])
        self.assertEqual(len(state["dirty"]),2)
        snap=sample()
        snap["deployment"]=state
        text=render(snap)
        self.assertIn("2 个健康工具文件未提交（service.py、extra.py）",text)
        self.assertIn("有未提交改动",text)

    def test_unreadable_git_is_unknown_not_a_warning(self):
        state=self.state(**{"rev-parse --abbrev-ref HEAD":_GitResult("",1,"fatal: not a repository")})
        self.assertEqual(state["quality"],"unknown")
        self.assertIsNone(state["current"])
        self.assertIn("RuntimeError",state["detail"])
        snap=sample()
        snap["deployment"]=state
        text=render(snap)
        self.assertIn("运行代码未知",text)
        self.assertNotIn("部署警告",text)

    def test_an_incident_notice_carries_the_deployment_warning_and_stays_short(self):
        snap=sample()
        snap["deployment"]=self.state(**{"rev-parse --abbrev-ref HEAD":"agent/fix",
                                         "rev-parse HEAD":"b"*40,
                                         "rev-list --count --left-right origin/main...HEAD":"0\t1"})
        text=report_text(snap,"异常健康报告",health={"instanceId":"test"})
        self.assertIn("**部署警告**",text)
        self.assertIn("异常说明",text)
        self.assertLess(len(text),1200)

    def test_tick_records_the_deployment_state_in_the_heartbeat(self):
        state=self.state()
        with tempfile.TemporaryDirectory() as directory:
            config={"state_dir":directory,"instances":[{"id":"test"}]}
            with patch("service.collect",return_value=sample()),patch("service.deployment_state",return_value=state):
                tick(config,allow_send=False)
            heartbeat=json.loads((Path(directory)/"heartbeat.json").read_text(encoding="utf-8"))
            self.assertEqual(heartbeat["deployment"],state)
            report=(Path(directory)/"latest.md").read_text(encoding="utf-8")
            self.assertIn("运行代码 main@aaaaaaaaaaaa",report)

    @unittest.skipUnless(shutil.which("git"),"git is not installed")
    def test_real_repository_detects_a_stale_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.run(["git","-C",directory,*args],capture_output=True,text=True,check=True).stdout.strip()
            git("init","-q")
            git("symbolic-ref","HEAD","refs/heads/main")
            git("-c","user.email=t@example.com","-c","user.name=t","commit","-q","--allow-empty","-m","one")
            git("update-ref","refs/remotes/origin/main",git("rev-parse","HEAD"))
            state=deployment_state(Path(directory))
            self.assertEqual(state["quality"],"observed")
            self.assertTrue(state["current"],state)
            git("checkout","-q","-b","next")
            git("-c","user.email=t@example.com","-c","user.name=t","commit","-q","--allow-empty","-m","two")
            git("update-ref","refs/remotes/origin/main",git("rev-parse","HEAD"))
            git("checkout","-q","main")
            stale=deployment_state(Path(directory))
            self.assertFalse(stale["current"])
            self.assertEqual(stale["reasons"],["behind"],stale)
            self.assertEqual(stale["behind"],1)
            (Path(directory)/"note.txt").write_text("uncommitted",encoding="utf-8")
            dirty=deployment_state(Path(directory))
            self.assertIn("dirty",dirty["reasons"])
            self.assertEqual(dirty["dirty"],["note.txt"])

class StateHintTests(unittest.TestCase):
    def issue(self):
        ticket={"id":"t1","title":"语义本体工单","stage":"person"}
        snap=sample()
        snap["instances"][0]["tickets"]=[ticket]
        return snap,{"id":"test:t1:review","instanceId":"test","ticketId":"t1","question":"语义本体工单","reason":"review","deadline":None}

    def test_attention_hint_names_the_configured_state_folder(self):
        snap,issue=self.issue()
        text=render_attention(snap,"待人工事项",issue,state_dir=r"D:\cloud\health\AERO17")
        self.assertIn(r"D:\cloud\health\AERO17\latest-attention.md",text)
        self.assertNotIn("%USERPROFILE%",text)

    def test_default_hint_keeps_the_profile_placeholder(self):
        snap,issue=self.issue()
        text=render_attention(snap,"待人工事项",issue)
        self.assertIn("%USERPROFILE%\\.dsh\\state\\superagent-health\\latest-attention.md",text)

    def test_incident_hint_follows_the_configured_state_folder(self):
        text=report_text(sample(),"异常健康报告",health={"instanceId":"test"},state_dir=r"D:\cloud\health\AERO17")
        self.assertIn(r"D:\cloud\health\AERO17\latest.md",text)


class StateMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.source=self.root/"state"
        self.source.mkdir()
        self.target=self.root/"cloud"/"health"
        self.config_file=self.root/"config.json"
        self.config_file.write_text(json.dumps({"instances":[{"id":"test","url":"http://127.0.0.1:9"}],
                                                "state_dir":str(self.source)}),encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def seed(self):
        store=Store(self.source)
        store.enqueue_group([("k-1",{"text":"x"})],0)
        store.close()
        (self.source/"latest.md").write_text("报告",encoding="utf-8")
        (self.source/"heartbeat.json").write_text("{}",encoding="utf-8")
        (self.source/"reporter.lock").write_bytes(b"0")

    def test_migration_keeps_outbox_and_rewrites_config(self):
        self.seed()
        result=migrate_state(load_config(self.config_file),self.config_file,str(self.target),write_config=True)
        self.assertEqual(result["outbox"],{"pending":1})
        self.assertTrue((self.target/"health.sqlite").is_file())
        self.assertEqual((self.target/"latest.md").read_text(encoding="utf-8"),"报告")
        self.assertEqual(json.loads(self.config_file.read_text(encoding="utf-8"))["state_dir"],str(self.target))
        self.assertFalse(self.source.exists())
        moved=Path(result["oldStateMovedTo"])
        self.assertTrue(moved.is_dir())
        self.assertTrue((moved/"health.sqlite").is_file())

    def test_migration_without_config_rewrite_keeps_the_old_folder(self):
        self.seed()
        result=migrate_state(load_config(self.config_file),self.config_file,str(self.target))
        self.assertFalse(result["configUpdated"])
        self.assertIsNone(result["oldStateMovedTo"])
        self.assertTrue(self.source.is_dir())
        self.assertEqual(json.loads(self.config_file.read_text(encoding="utf-8"))["state_dir"],str(self.source))

    def test_migration_refuses_a_nested_same_or_occupied_target(self):
        self.seed()
        config=load_config(self.config_file)
        with self.assertRaises(ValueError):
            migrate_state(config,self.config_file,str(self.source/"inner"))
        with self.assertRaises(ValueError):
            migrate_state(config,self.config_file,str(self.source))
        occupied=self.root/"occupied"
        occupied.mkdir()
        (occupied/"health.sqlite").write_text("x",encoding="utf-8")
        with self.assertRaises(ValueError):
            migrate_state(config,self.config_file,str(occupied))

if __name__=="__main__":
    unittest.main(verbosity=2)

