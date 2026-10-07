#!/usr/bin/env python3
"""
UNIT TESTS FOR PAYPAL SANDBOX AI CLIENT & MARKET AGENT
================================================================================
Tests OAuth, order creation, capture, webhook verification, and AI intelligence.
"""

import unittest
from unittest.mock import patch, MagicMock
import json
import io

from paypal_sandbox_client import PayPalSandboxAIClient


class TestPayPalSandboxAIClient(unittest.TestCase):
    def setUp(self):
        self.client_no_creds = PayPalSandboxAIClient(client_id="", client_secret="")
        self.client_with_creds = PayPalSandboxAIClient(
            client_id="test_client_id_123",
            client_secret="test_secret_456",
            webhook_id="test_webhook_789",
        )

    def test_oauth2_missing_credentials_returns_none(self):
        token = self.client_no_creds.get_oauth2_access_token()
        self.assertIsNone(token)

    @patch("urllib.request.urlopen")
    def test_oauth2_mock_success_token(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "access_token": "A21AA_TEST_TOKEN_XYZ",
            "expires_in": 3600
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        token = self.client_with_creds.get_oauth2_access_token()
        self.assertEqual(token, "A21AA_TEST_TOKEN_XYZ")

    def test_build_create_order_payload_structure(self):
        payload = self.client_no_creds.build_create_order_payload("ETH", "49.00", "custom_ref_99")
        self.assertEqual(payload["intent"], "CAPTURE")
        self.assertEqual(len(payload["purchase_units"]), 1)
        unit = payload["purchase_units"][0]
        self.assertEqual(unit["reference_id"], "ai_session_eth")
        self.assertEqual(unit["custom_id"], "custom_ref_99")
        self.assertEqual(unit["amount"]["currency_code"], "USD")
        self.assertEqual(unit["amount"]["value"], "49.00")
        self.assertEqual(payload["application_context"]["user_action"], "PAY_NOW")

    def test_create_order_without_credentials_fails_closed(self):
        res = self.client_no_creds.create_order("BTC", "19.00")
        self.assertEqual(res["status"], "BLOCKED_AWAITING_PAYPAL_SANDBOX_CREDENTIALS")
        self.assertIn("payload_ready", res)

    @patch.object(PayPalSandboxAIClient, "get_oauth2_access_token", return_value="MOCK_TOKEN")
    @patch("urllib.request.urlopen")
    def test_create_order_mock_api_success(self, mock_urlopen, mock_token):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "id": "ORD_123456789",
            "status": "CREATED",
            "links": [{"rel": "approve", "href": "https://sandbox.paypal.com/checkoutnow?token=ORD_123456789"}]
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response

        res = self.client_with_creds.create_order("BTC", "19.00")
        self.assertEqual(res["status"], "SUCCESS")
        self.assertEqual(res["order"]["id"], "ORD_123456789")

    def test_capture_order_without_credentials_fails_closed(self):
        res = self.client_no_creds.capture_order("ORD_VALID_ID")
        self.assertEqual(res["status"], "BLOCKED_AWAITING_PAYPAL_SANDBOX_CREDENTIALS")

    def test_capture_order_invalid_id_rejected(self):
        res = self.client_with_creds.capture_order("invalid;id'--")
        self.assertEqual(res["status"], "INVALID_ORDER_ID")

    def test_verify_webhook_missing_headers_fails(self):
        headers = {"some-header": "value"}
        body = json.dumps({"event_type": "PAYMENT.CAPTURE.COMPLETED"})
        res = self.client_no_creds.verify_webhook_signature(headers, body)
        self.assertFalse(res["verified"])
        self.assertIn("MISSING_MANDATORY_HEADERS", res["reason"])

    def test_verify_webhook_invalid_json_fails(self):
        headers = {
            "paypal-transmission-id": "tx_123",
            "paypal-transmission-time": "2026-10-07T20:00:00Z",
            "paypal-transmission-sig": "sig_abc",
            "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
        }
        res = self.client_no_creds.verify_webhook_signature(headers, "invalid-json{{")
        self.assertFalse(res["verified"])
        self.assertIn("INVALID_JSON_BODY", res["reason"])

    def test_verify_webhook_headers_without_credentials_fail_closed(self):
        headers = {
            "PAYPAL-TRANSMISSION-ID": "tx_123",
            "PAYPAL-TRANSMISSION-TIME": "2026-10-07T20:00:00Z",
            "PAYPAL-TRANSMISSION-SIG": "sig_abc",
            "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/cert",
        }
        body = json.dumps({"event_type": "PAYMENT.CAPTURE.COMPLETED", "id": "EVT_001"})
        res = self.client_no_creds.verify_webhook_signature(headers, body)
        self.assertFalse(res["verified"])
        self.assertEqual(res["status"], "BLOCKED_AWAITING_PAYPAL_WEBHOOK_VERIFICATION")
        self.assertEqual(res["method"], "NO_CRYPTOGRAPHIC_VERIFICATION_PERFORMED")
        self.assertEqual(res["event_type"], "PAYMENT.CAPTURE.COMPLETED")

    @patch.object(PayPalSandboxAIClient, "get_oauth2_access_token", return_value="MOCK_TOKEN")
    @patch("urllib.request.urlopen")
    def test_verify_webhook_official_api_success(self, mock_urlopen, _mock_token):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"verification_status": "SUCCESS"}).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_response
        headers = {
            "PAYPAL-TRANSMISSION-ID": "tx_123",
            "PAYPAL-TRANSMISSION-TIME": "2026-10-07T20:00:00Z",
            "PAYPAL-TRANSMISSION-SIG": "sig_abc",
            "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/cert",
            "PAYPAL-AUTH-ALGO": "SHA256withRSA",
        }
        res = self.client_with_creds.verify_webhook_signature(
            headers, json.dumps({"event_type": "PAYMENT.CAPTURE.COMPLETED"})
        )
        self.assertTrue(res["verified"])
        self.assertEqual(res["method"], "PAYPAL_SANDBOX_API_VERIFICATION")

    def test_generate_ai_market_intelligence_success(self):
        capture_result = {"status": "SUCCESS", "capture": {"id": "CAPTURE_123", "status": "COMPLETED"}}
        telemetry = {
            "symbol": "BTC",
            "timestamp": "2026-10-08T00:00:00Z",
            "source_count": 3,
            "sources": ["binance", "coinbase", "okx"],
            "byzantine_median_price_usd": 83450.0,
        }
        report = self.client_no_creds.generate_ai_market_intelligence(
            "BTC",
            capture_result,
            telemetry,
            reasoning_provider=lambda _data: {"regime": "RANGE", "rationale": "Verified test provider output"},
        )
        self.assertEqual(report["symbol"], "BTC")
        self.assertEqual(report["reasoning"]["regime"], "RANGE")
        self.assertIn("verification_sha256", report)
        self.assertEqual(report["status"], "GENERATED_NOT_DISPATCHED")

    def test_generate_ai_requires_real_provider(self):
        capture_result = {"status": "SUCCESS", "capture": {"id": "CAPTURE_123", "status": "COMPLETED"}}
        telemetry = {
            "symbol": "BTC", "timestamp": "2026-10-08T00:00:00Z", "source_count": 2,
            "sources": ["binance", "coinbase"], "byzantine_median_price_usd": 83450.0,
        }
        report = self.client_no_creds.generate_ai_market_intelligence("BTC", capture_result, telemetry)
        self.assertEqual(report["error"], "AI_REASONING_PROVIDER_REQUIRED")
        self.assertEqual(report["status"], "BLOCKED")

    def test_generate_ai_market_intelligence_unverified_payment_rejected(self):
        capture_result = {"status": "SUCCESS", "capture": {"id": "CAPTURE_123", "status": "PENDING"}}
        report = self.client_no_creds.generate_ai_market_intelligence("SOL", capture_result)
        self.assertIn("error", report)
        self.assertEqual(report["error"], "PAYMENT_NOT_VERIFIED")


if __name__ == "__main__":
    unittest.main()
