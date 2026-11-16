"""Behavioral checks for health evidence and reliable delivery boundaries."""
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from common import CST, instant, safe_text, digest
from events import fold_events
from collect import instance, report_from_detail, tickets
from delivery import send, binding_id, DeliveryError
from render import chunks, render, render_attention, report_text
from store import Store
from service import quiet, next_open, plan, dispatch, enqueue_report, settle_seconds, tick

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

    def test_attention_notice_is_a_short_list_not_the_whole_report(self):
        snap=sample()
        snap["instances"][0]["tickets"]=[{"id":"t1","title":"语义本体工单","stage":"person","recap":{"text":"等待决定","quality":"worker_report_not_independently_verified"}}]
        issue={"id":"test:t1:attention","issueId":"test:t1:attention","revision":"r1","instanceId":"test","ticketId":"t1","question":"是否继续？","reason":"answer","deadline":None}
        text=render_attention(snap,"待人工事项",issue)
        self.assertTrue(text.startswith("# Superagent · 待人工事项"))
        self.assertIn("- 工单：**t1** 语义本体工单 · 待人工",text)
        self.assertIn("- 问题：是否继续？",text)
        self.assertIn("- 原因：answer",text)
        self.assertIn("完整待人工事项报告",text)
        self.assertIn("latest-attention.md",text)
        self.assertIn("每两小时整点的「健康报告」",text)
        self.assertNotIn("## 今日用量",text)
        self.assertEqual(text,report_text(snap,"待人工事项",issue))

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

    def test_reminder_still_follows_an_accepted_notice(self):
        self.plan_at(self.snapshot(NOW),NOW+timedelta(seconds=200))
        row=self.store.db.execute("SELECT key FROM outbox WHERE state='pending'").fetchone()
        self.store.accepted(row["key"],"om_receipt",now=(NOW+timedelta(seconds=200)).timestamp())
        self.plan_at(self.snapshot(NOW),NOW+timedelta(minutes=35))
        self.assertEqual(len(self.notices("待人工提醒")),1)


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
            if url.endswith("/tickets/t1"): return {"attention":{"id":"attention-1","question":"是否继续？"}},None
            return None,"http_404"
        with patch("collect.get",side_effect=fake_get):
            first=instance({},{"id":"test","url":"http://127.0.0.1:3082"},NOW,Reader())
            items[0]["updatedAt"]="2026-11-12T06:03:00Z"
            second=instance({},{"id":"test","url":"http://127.0.0.1:3082"},NOW,Reader())
        before,after=first["humanItems"][0],second["humanItems"][0]
        self.assertEqual(before["revision"],after["revision"])
        self.assertEqual(before["updatedAt"],"2026-11-12T06:00:00Z")
        self.assertEqual(after["updatedAt"],"2026-11-12T06:03:00Z")


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

if __name__=="__main__":
    unittest.main(verbosity=2)
