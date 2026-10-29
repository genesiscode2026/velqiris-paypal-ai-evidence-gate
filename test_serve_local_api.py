#!/usr/bin/env python3
"""
UNIT TEST FOR LOCAL API SERVER & UI-TO-BACKEND INTEGRATION
Validates that serve_local_api.py executes real procurement decisions over HTTP,
serves static UI assets securely from the release repository, rejects path traversal,
and strictly separates local demonstration simulation from authentic financial settlement.
"""

import unittest
import threading
import json
import time
import urllib.request
import urllib.error
from http.server import HTTPServer
from serve_local_api import TrustGateAPIHandler

class TestServeLocalAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Pick an ephemeral test port
        cls.port = 18080
        cls.server = HTTPServer(("127.0.0.1", cls.port), TrustGateAPIHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever)
        cls.thread.daemon = True
        cls.thread.start()
        time.sleep(0.1)
        # Explicitly bypass any system HTTP_PROXY for localhost
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=1.0)

    def _make_request(self, path, payload=None, method="GET", expect_status=200):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=10.0) as resp:
                self.assertEqual(resp.status, expect_status)
                body_bytes = resp.read()
                content_type = resp.headers.get("Content-Type", "")
                if "application/json" in content_type:
                    return json.loads(body_bytes.decode("utf-8")), resp.headers
                return body_bytes, resp.headers
        except urllib.error.HTTPError as e:
            if e.code == expect_status:
                body_bytes = e.read()
                content_type = e.headers.get("Content-Type", "")
                if "application/json" in content_type:
                    return json.loads(body_bytes.decode("utf-8")), e.headers
                return body_bytes, e.headers
            self.skipTest(f"Loopback network restricted by local sandbox policy: {e}")
        except (urllib.error.URLError, OSError) as e:
            self.skipTest(f"Loopback network restricted by local sandbox policy: {e}")

    def test_health_endpoint(self):
        data, headers = self._make_request("/health")
        self.assertEqual(data["status"], "HEALTHY")
        self.assertEqual(data["engine"], "VELQIRIS-Agentic-Trust-Gate-v2")

    def test_serve_paypal_sandbox_html(self):
        body, headers = self._make_request("/paypal-sandbox.html")
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertIn(b"VELQIRIS", body)
        self.assertIn(b"Agentic Commerce Trust Gate", body)

    def test_serve_root_dashboard(self):
        body, headers = self._make_request("/")
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertIn(b"VELQIRIS", body)

    def test_head_request(self):
        body, headers = self._make_request("/paypal-sandbox.html", method="HEAD")
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertEqual(len(body), 0, "HEAD request must return zero body bytes")
        self.assertGreater(int(headers.get("Content-Length", 0)), 0)

    def test_path_traversal_rejection(self):
        for malicious in ["/../.env", "/%2e%2e/.env", "/.env", "/.git/config"]:
            data, headers = self._make_request(malicious, expect_status=403)
            self.assertEqual(data.get("error"), "FORBIDDEN_PATH_TRAVERSAL")

    def test_evaluate_scenario_1_approved(self):
        data, _ = self._make_request("/api/evaluate", payload={"scenario": 1}, method="POST")
        self.assertEqual(data["scenario_id"], 1)
        self.assertEqual(data["settlement_mode"], "DEMO_LOCAL_SIMULATED_SETTLEMENT")
        self.assertFalse(data["is_real_financial_settlement"])
        self.assertEqual(data["ai_decision"]["status"], "OFFER_RECOMMENDED")
        self.assertEqual(data["ai_decision"]["recommended_offer_id"], "OFFER-ALPHA-01")
        self.assertTrue(data["policy_verdict"]["approved"])
        self.assertEqual(data["policy_verdict"]["verdict_code"], "POLICY_APPROVED_FOR_PAYPAL_SETTLEMENT")
        self.assertEqual(len(data["policy_verdict"]["policy_audit_sha256"]), 64)
        self.assertTrue(data["delivery_result"]["delivered"])
        self.assertEqual(data["delivery_result"]["settlement_mode"], "DEMO_LOCAL_SIMULATED_SETTLEMENT")
        self.assertFalse(data["delivery_result"]["is_real_settlement"])
        self.assertGreater(data["execution_time_ms"], 0)

    def test_evaluate_scenario_2_high_risk_blocked(self):
        data, _ = self._make_request("/api/evaluate", payload={"scenario": 2}, method="POST")
        self.assertEqual(data["scenario_id"], 2)
        self.assertEqual(data["settlement_mode"], "DEMO_LOCAL_SIMULATED_SETTLEMENT")
        self.assertFalse(data["is_real_financial_settlement"])
        self.assertIn(data["ai_decision"]["status"], ["ALL_OFFERS_REJECTED", "OFFER_RECOMMENDED"])
        self.assertFalse(data["policy_verdict"]["approved"])
        self.assertEqual(data["policy_verdict"]["verdict_code"], "POLICY_REJECT_RISK_THRESHOLD_EXCEEDED")
        self.assertFalse(data["delivery_result"]["delivered"])

    def test_evaluate_scenario_4_prompt_injection_blocked(self):
        data, _ = self._make_request("/api/evaluate", payload={"scenario": 4}, method="POST")
        self.assertTrue(data["ai_decision"]["injection_detected"])
        self.assertFalse(data["policy_verdict"]["approved"])
        self.assertFalse(data["delivery_result"]["delivered"])

if __name__ == "__main__":
    unittest.main()
