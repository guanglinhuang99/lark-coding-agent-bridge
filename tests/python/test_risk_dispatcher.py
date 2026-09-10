"""Dependency-free tests for bridge admission and queued cancellation."""
from __future__ import annotations
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "risk_bridge", Path(__file__).resolve().parents[2] / "src/wecom/risk/direct_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class FakeService:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.called = []
    def call(self, method, args, progress):
        self.called.append(method)
        if method == "blocking":
            self.entered.set()
            if not self.release.wait(2):
                raise RuntimeError("test release timed out")
        progress("done")
        return {"method": method}


class FakePretradeWeb:
    PRETRADE_RUNS_LOCK = threading.Lock()

    def __init__(self):
        self.PRETRADE_RUNS = {}
        self.payloads = []

    def start_pretrade_run(self, payload):
        self.payloads.append(payload)
        run_id = f"run-{len(self.payloads)}"
        self.PRETRADE_RUNS[run_id] = {
            "id": run_id,
            "status": "success",
            "progress": "测算完成",
            "result": {"actions": payload["actions"]},
        }
        return {"id": run_id}


def pretrade_service(web):
    service = bridge.DirectRiskService.__new__(bridge.DirectRiskService)
    service.web = web
    return service

class DispatcherTests(unittest.TestCase):
    def test_pretrade_submits_a_batch_once(self):
        web = FakePretradeWeb()
        service = pretrade_service(web)
        actions = [
            {"type": "buy", "amount": 0.1, "security_name": "102583394.IB"},
            {"type": "buy", "amount": 0.4, "security_name": "232580009.IB"},
        ]

        result = service._calculate_pretrade("ESG1号", actions, lambda _message: None)

        self.assertEqual(len(web.payloads), 1)
        self.assertEqual(web.payloads[0], {"product": "ESG1号", "actions": actions})
        self.assertEqual(result["result"]["actions"], actions)
        self.assertIn("bridge_timings", result)
        self.assertGreaterEqual(result["bridge_timings"]["total_ms"], 0)
        self.assertGreaterEqual(result["bridge_timings"]["submit_ms"], 0)
        self.assertGreaterEqual(result["bridge_timings"]["poll_ms"], 0)

    def test_pretrade_preserves_legacy_single_action_submission(self):
        web = FakePretradeWeb()
        service = pretrade_service(web)
        action = {"type": "buy", "amount": 0.1, "security_name": "102583394.IB"}

        service._calculate_pretrade("ESG1号", action, lambda _message: None)

        self.assertEqual(web.payloads, [{"product": "ESG1号", "actions": [action]}])

    def test_pretrade_rejects_empty_or_malformed_action_lists(self):
        web = FakePretradeWeb()
        service = pretrade_service(web)
        for raw_action in ([], [{"type": "buy"}, "not-an-object"]):
            with self.subTest(raw_action=raw_action):
                with self.assertRaises(ValueError):
                    service._calculate_pretrade("ESG1号", raw_action, lambda _message: None)
        self.assertEqual(web.payloads, [])

    def test_cancel_queued_and_bound_admission(self):
        service, messages = FakeService(), []
        with patch.object(bridge, "write_message", messages.append), ThreadPoolExecutor(max_workers=1) as pool:
            dispatcher = bridge.RequestDispatcher(service, pool, max_pending=2)
            try:
                dispatcher.submit({"id": "a", "method": "blocking"})
                self.assertTrue(service.entered.wait(1))
                dispatcher.submit({"id": "b", "method": "queued"})
                dispatcher.submit({"id": "b", "method": "cancel"})
                dispatcher.submit({"id": "c", "method": "replacement"})
                dispatcher.submit({"id": "d", "method": "overflow"})
            finally:
                service.release.set()
        self.assertEqual(service.called, ["blocking", "replacement"])
        self.assertTrue(any(m.get("id") == "d" and m.get("code") == "direct-capacity" for m in messages))
        self.assertEqual(dispatcher.requests, {})

    def test_cancel_running_retains_slot_until_backend_finishes(self):
        service, messages = FakeService(), []
        with patch.object(bridge, "write_message", messages.append), ThreadPoolExecutor(max_workers=1) as pool:
            dispatcher = bridge.RequestDispatcher(service, pool, max_pending=1)
            try:
                dispatcher.submit({"id": "a", "method": "blocking"})
                self.assertTrue(service.entered.wait(1))
                dispatcher.submit({"id": "a", "method": "cancel"})
                dispatcher.submit({"id": "b", "method": "overflow"})
                self.assertIn("a", dispatcher.requests)
            finally:
                service.release.set()
        self.assertFalse(any(m.get("id") == "a" for m in messages))
        self.assertEqual(service.called, ["blocking"])

    def test_invalid_timeout_does_not_stop_dispatcher_or_leak_slot(self):
        service, messages = FakeService(), []
        with patch.object(bridge, "write_message", messages.append), ThreadPoolExecutor(max_workers=1) as pool:
            dispatcher = bridge.RequestDispatcher(service, pool, max_pending=1)
            dispatcher.submit({"id": "bad", "method": "query", "timeout_ms": "invalid"})
            dispatcher.submit({"id": "good", "method": "query"})
        self.assertEqual(service.called, ["query"])
        self.assertTrue(any(m.get("id") == "bad" and m.get("type") == "error" for m in messages))

    def test_expired_request_never_reaches_backend(self):
        service, messages = FakeService(), []
        with patch.object(bridge, "write_message", messages.append):
            bridge.handle_request(service, {"id": "expired", "method": "query"},
                                  threading.Event(), deadline=0)
        self.assertEqual(service.called, [])
        self.assertTrue(any(m.get("type") == "error" for m in messages))

if __name__ == "__main__":
    unittest.main()
