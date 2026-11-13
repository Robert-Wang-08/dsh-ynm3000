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
from collect import report_from_detail, tickets
from delivery import send, binding_id, DeliveryError
from render import chunks, render
from store import Store
from service import quiet, next_open, plan, dispatch, enqueue_report

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
