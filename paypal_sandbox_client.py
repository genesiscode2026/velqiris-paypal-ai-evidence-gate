#!/usr/bin/env python3
"""
VELQIRIS × PAYPAL AI HACKATHON 2026: SANDBOX GATEWAY & AI AGENT
================================================================================
Target: PayPal AI Hackathon 2026 (Devpost)
Environment: PayPal Developer Sandbox (https://api-m.sandbox.paypal.com)

HARD ARCHITECTURAL INVARIANT:
- This sandbox gateway is strictly isolated for hackathon prototype evaluation.
- VELQIRIS production software asset acquisition remains strictly settled in
  USDC on Base (0xC6F8...D144) per VELQIRIS_PAYMENT_RAIL_LAW.md.
================================================================================
"""

import os
import sys
import json
import time
import hmac
import hashlib
import base64
import urllib.request
import urllib.error
from typing import Dict, Any, Optional

PAYPAL_CLIENT_ID = os.environ.get("PAYPAL_SANDBOX_CLIENT_ID", "")
PAYPAL_CLIENT_SECRET = os.environ.get("PAYPAL_SANDBOX_CLIENT_SECRET", "")
PAYPAL_WEBHOOK_ID = os.environ.get("PAYPAL_SANDBOX_WEBHOOK_ID", "")
SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com"


class PayPalSandboxAIClient:
    """
    Client for PayPal Developer Sandbox REST APIs & Autonomous AI Market Intelligence Agent.
    Implements OAuth2 client credentials, order creation, order capture,
    webhook verification, and post-payment quantitative intelligence generation.
    """

    def __init__(
        self,
        client_id: str = PAYPAL_CLIENT_ID,
        client_secret: str = PAYPAL_CLIENT_SECRET,
        webhook_id: str = PAYPAL_WEBHOOK_ID,
        api_base: str = SANDBOX_API_BASE,
    ):
        self.client_id = client_id
        self.client_secret = client_secret
        self.webhook_id = webhook_id
        self.api_base = api_base
        self.access_token: Optional[str] = None
        self.token_expiry: float = 0.0

    def get_oauth2_access_token(self) -> Optional[str]:
        """Fetches OAuth2 bearer token from PayPal Sandbox."""
        if not self.client_id or not self.client_secret:
            return None

        # Return cached token if still valid
        if self.access_token and time.time() < self.token_expiry - 60:
            return self.access_token

        auth_header = base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode("utf-8")
        ).decode("utf-8")

        req = urllib.request.Request(
            f"{self.api_base}/v1/oauth2/token",
            data=b"grant_type=client_credentials",
            headers={
                "Authorization": f"Basic {auth_header}",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "VELQIRIS-PayPal-AI-Client/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self.access_token = data.get("access_token")
                expires_in = data.get("expires_in", 3600)
                self.token_expiry = time.time() + expires_in
                return self.access_token
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8", errors="ignore")
            print(f"[PayPal Sandbox] OAuth2 HTTP {e.code}: {error_body}")
            return None
        except Exception as e:
            print(f"[PayPal Sandbox] OAuth2 Error: {e}")
            return None

    def build_create_order_payload(
        self,
        symbol: str = "BTC",
        amount_usd: str = "19.00",
        custom_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Creates an order specification for an AI market intelligence query session.
        """
        cid = custom_id or f"velqiris_ai_session_{symbol.lower()}_{int(time.time())}"
        return {
            "intent": "CAPTURE",
            "purchase_units": [
                {
                    "reference_id": f"ai_session_{symbol.lower()}",
                    "custom_id": cid,
                    "description": f"VELQIRIS AI Quantitative Intelligence Pass ({symbol.upper()})",
                    "amount": {
                        "currency_code": "USD",
                        "value": amount_usd,
                    },
                }
            ],
            "application_context": {
                "brand_name": "VELQIRIS Financial AI",
                "landing_page": "NO_PREFERENCE",
                "user_action": "PAY_NOW",
                "return_url": "https://velqiris-acquisition.netlify.app/#payment-success",
                "cancel_url": "https://velqiris-acquisition.netlify.app/#payment-cancelled",
            },
        }

    def create_order(
        self,
        symbol: str = "BTC",
        amount_usd: str = "19.00",
        custom_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Submits order creation request to PayPal Sandbox `/v2/checkout/orders`.
        If credentials are not configured, fails closed cleanly with informative status.
        """
        payload = self.build_create_order_payload(symbol, amount_usd, custom_id)
        token = self.get_oauth2_access_token()

        if not token:
            return {
                "status": "BLOCKED_AWAITING_PAYPAL_SANDBOX_CREDENTIALS",
                "message": "Set PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET to execute live Sandbox API call.",
                "payload_ready": payload,
            }

        req = urllib.request.Request(
            f"{self.api_base}/v2/checkout/orders",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
                "User-Agent": "VELQIRIS-PayPal-AI-Client/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return {"status": "SUCCESS", "order": data}
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8", errors="ignore")
            return {"status": "HTTP_ERROR", "code": e.code, "error": error_body}
        except Exception as e:
            return {"status": "NETWORK_ERROR", "error": str(e)}

    def capture_order(self, order_id: str) -> Dict[str, Any]:
        """
        Captures authorized payment for an order via `/v2/checkout/orders/{order_id}/capture`.
        """
        import re
        if not order_id or not re.match(r"^[A-Za-z0-9_-]+$", order_id):
            return {"status": "INVALID_ORDER_ID", "error": "Order ID must be alphanumeric (hyphens/underscores allowed)"}

        token = self.get_oauth2_access_token()
        if not token:
            return {
                "status": "BLOCKED_AWAITING_PAYPAL_SANDBOX_CREDENTIALS",
                "order_id": order_id,
            }

        req = urllib.request.Request(
            f"{self.api_base}/v2/checkout/orders/{order_id}/capture",
            data=b"{}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
                "User-Agent": "VELQIRIS-PayPal-AI-Client/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return {"status": "SUCCESS", "capture": data}
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8", errors="ignore")
            return {"status": "HTTP_ERROR", "code": e.code, "error": error_body}
        except Exception as e:
            return {"status": "NETWORK_ERROR", "error": str(e)}

    def verify_webhook_signature(
        self,
        headers: Dict[str, str],
        raw_body: str,
        webhook_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Validates webhook delivery against PayPal sandbox.
        If credentials and webhook_id are present, executes official API verification
        via POST /v1/notifications/verify-webhook-signature.
        Without credentials and a registered webhook ID, verification fails closed.
        """
        lower_headers = {k.lower(): v for k, v in headers.items()}
        required = [
            "paypal-transmission-id",
            "paypal-transmission-time",
            "paypal-transmission-sig",
            "paypal-cert-url",
        ]

        missing_headers = [h for h in required if h not in lower_headers]
        if missing_headers:
            return {
                "verified": False,
                "reason": f"MISSING_MANDATORY_HEADERS: {', '.join(missing_headers)}",
            }

        try:
            parsed_event = json.loads(raw_body)
        except Exception as e:
            return {"verified": False, "reason": f"INVALID_JSON_BODY: {e}"}

        wid = webhook_id or self.webhook_id
        token = self.get_oauth2_access_token()

        if token and wid:
            verify_payload = {
                "transmission_id": lower_headers.get("paypal-transmission-id"),
                "transmission_time": lower_headers.get("paypal-transmission-time"),
                "transmission_sig": lower_headers.get("paypal-transmission-sig"),
                "cert_url": lower_headers.get("paypal-cert-url"),
                "auth_algo": lower_headers.get("paypal-auth-algo", "SHA256withRSA"),
                "webhook_id": wid,
                "webhook_event": parsed_event,
            }
            req = urllib.request.Request(
                f"{self.api_base}/v1/notifications/verify-webhook-signature",
                data=json.dumps(verify_payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "User-Agent": "VELQIRIS-PayPal-AI-Client/1.0",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    resp_data = json.loads(resp.read().decode("utf-8"))
                    status = resp_data.get("verification_status")
                    return {
                        "verified": status == "SUCCESS",
                        "status": status,
                        "method": "PAYPAL_SANDBOX_API_VERIFICATION",
                        "event_type": parsed_event.get("event_type"),
                    }
            except Exception as e:
                return {
                    "verified": False,
                    "reason": f"API_VERIFICATION_FAILED: {e}",
                    "method": "PAYPAL_SANDBOX_API_VERIFICATION",
                }

        # Header presence is not signature verification. Never unlock paid behavior here.
        return {
            "verified": False,
            "status": "BLOCKED_AWAITING_PAYPAL_WEBHOOK_VERIFICATION",
            "method": "NO_CRYPTOGRAPHIC_VERIFICATION_PERFORMED",
            "transmission_id": lower_headers.get("paypal-transmission-id"),
            "event_type": parsed_event.get("event_type"),
            "reason": "Official PayPal verification requires sandbox credentials and PAYPAL_SANDBOX_WEBHOOK_ID.",
        }

    def generate_ai_market_intelligence(
        self,
        symbol: str,
        capture_result: Dict[str, Any],
        telemetry: Optional[Dict[str, Any]] = None,
        reasoning_provider=None,
    ) -> Dict[str, Any]:
        """
        Runs an explicitly supplied AI reasoning provider only after a confirmed PayPal
        capture and after real, provenance-bearing market telemetry is supplied.
        """
        sym = symbol.upper()
        capture = capture_result.get("capture") if capture_result.get("status") == "SUCCESS" else None
        if not isinstance(capture, dict) or capture.get("status") != "COMPLETED" or not capture.get("id"):
            return {
                "error": "PAYMENT_NOT_VERIFIED",
                "status": "BLOCKED",
                "message": "A PayPal capture object with id and status COMPLETED is required.",
            }
        if not isinstance(telemetry, dict):
            return {"error": "MARKET_TELEMETRY_REQUIRED", "status": "BLOCKED"}
        required = ("symbol", "timestamp", "source_count", "sources", "byzantine_median_price_usd")
        missing = [field for field in required if telemetry.get(field) in (None, "", [])]
        if missing or int(telemetry.get("source_count", 0)) < 2:
            return {"error": "INSUFFICIENT_VERIFIED_TELEMETRY", "status": "BLOCKED", "missing": missing}
        if telemetry.get("symbol", "").upper() != sym:
            return {"error": "SYMBOL_MISMATCH", "status": "BLOCKED"}
        if not callable(reasoning_provider):
            return {
                "error": "AI_REASONING_PROVIDER_REQUIRED",
                "status": "BLOCKED",
                "message": "No model execution is claimed until an authenticated reasoning provider is supplied.",
            }

        reasoning = reasoning_provider(telemetry)
        if not isinstance(reasoning, dict) or not reasoning.get("regime") or not reasoning.get("rationale"):
            return {"error": "INVALID_AI_PROVIDER_RESPONSE", "status": "BLOCKED"}

        evidence = {
            "capture_id": capture["id"],
            "symbol": sym,
            "telemetry_timestamp": telemetry["timestamp"],
            "sources": telemetry["sources"],
            "reasoning": reasoning,
        }
        return {
            **evidence,
            "status": "GENERATED_NOT_DISPATCHED",
            "verification_sha256": hashlib.sha256(
                json.dumps(evidence, sort_keys=True).encode("utf-8")
            ).hexdigest(),
        }


if __name__ == "__main__":
    client = PayPalSandboxAIClient()
    order_payload = client.build_create_order_payload("BTC", "19.00")
    print("PAYPAL SANDBOX AI ORDER PAYLOAD:")
    print(json.dumps(order_payload, indent=2))

    sample_capture = {"status": "BLOCKED_AWAITING_PAYPAL_SANDBOX_CREDENTIALS"}
    ai_report = client.generate_ai_market_intelligence("BTC", sample_capture)
    print("\nAI MARKET INTELLIGENCE STATUS:")
    print(json.dumps(ai_report, indent=2))
