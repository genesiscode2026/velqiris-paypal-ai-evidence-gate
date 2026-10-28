#!/usr/bin/env python3
"""
UNIT & RED TEAM TEST SUITE — PAYPAL SERVER ENGINE & SETTLEMENT RECONCILIATION
Validates Gates P0-D, P0-E, and P0-G: State Machine, Webhook Reconciliation,
Replay Defense, Tampering Prevention, and Single-Use Digital Delivery.
"""

import unittest
import json
import uuid
import hashlib
from paypal_server_engine import (
    OrderState,
    TransactionContext,
    IdempotencyRegistry,
    SettlementReconciliationGate,
    DigitalDeliveryGate,
)

class TestPayPalServerEngine(unittest.TestCase):
    def setUp(self):
        self.registry = IdempotencyRegistry(":memory:")
        self.reconciliation_gate = SettlementReconciliationGate(self.registry)
        self.delivery_gate = DigitalDeliveryGate(self.registry)
        
        self.ctx = TransactionContext(
            session_id="SESS-TEST-001",
            mandate_id="MANDATE-TEST-001",
            decision_id="DEC-TEST-001",
            merchant_id="528WKSF7HVQHA",
            authorized_amount_usd="19.00",
            authorized_currency="USD",
            custom_id="POLICY_HASH_ABC123",
            order_id="ORD-TEST-9999",
        )

    def tearDown(self):
        self.registry.close()

    def test_state_machine_valid_progression(self):
        """Verifies strict state machine transition path from INITIATED to DELIVERED."""
        self.assertEqual(self.ctx.state, OrderState.INITIATED)
        self.assertTrue(self.ctx.transition_to(OrderState.ORDER_CREATED))
        self.assertTrue(self.ctx.transition_to(OrderState.BUYER_APPROVED))
        self.assertTrue(self.ctx.transition_to(OrderState.CAPTURE_PENDING))
        self.assertTrue(self.ctx.transition_to(OrderState.CAPTURE_COMPLETED))
        self.assertTrue(self.ctx.transition_to(OrderState.SETTLEMENT_VERIFIED))
        self.assertTrue(self.ctx.transition_to(OrderState.DELIVERED))

    def test_state_machine_illegal_skip_blocked(self):
        """Red Team: Attempts to skip from ORDER_CREATED directly to DELIVERED."""
        self.ctx.transition_to(OrderState.ORDER_CREATED)
        res = self.ctx.transition_to(OrderState.DELIVERED)
        self.assertFalse(res)
        self.assertIn("ILLEGAL_STATE_TRANSITION", self.ctx.failure_reason)

    def test_idempotency_duplicate_request_blocked(self):
        """Verifies duplicate request IDs are rejected."""
        req_id = "REQ-ID-UUID-1234"
        first = self.registry.register_request_id(req_id, "ORDER-1")
        self.assertTrue(first)
        second = self.registry.register_request_id(req_id, "ORDER-1-DUPE")
        self.assertFalse(second)

    def _prepare_approved_ctx(self) -> TransactionContext:
        ctx = TransactionContext(
            session_id="SESS-APP-002",
            mandate_id="MANDATE-002",
            decision_id="DEC-002",
            merchant_id="528WKSF7HVQHA",
            authorized_amount_usd="19.00",
            authorized_currency="USD",
            custom_id="POLICY_HASH_SECURE",
            order_id="ORD-APPROVED-777",
        )
        ctx.transition_to(OrderState.ORDER_CREATED)
        ctx.transition_to(OrderState.BUYER_APPROVED)
        ctx.transition_to(OrderState.CAPTURE_PENDING)
        ctx.transition_to(OrderState.CAPTURE_COMPLETED)
        return ctx

    def test_reconciliation_valid_capture_succeeds(self):
        """Verifies legitimate PAYMENT.CAPTURE.COMPLETED webhook transitions to SETTLEMENT_VERIFIED."""
        ctx = self._prepare_approved_ctx()
        headers = {
            "paypal-transmission-id": "TX-LEGIT-001",
            "paypal-transmission-time": "2026-10-28T18:00:00Z",
            "paypal-transmission-sig": "mock_valid_signature",
            "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
        }
        body = {
            "event_type": "PAYMENT.CAPTURE.COMPLETED",
            "resource": {
                "id": "CAP-LEGIT-888",
                "status": "COMPLETED",
                "amount": {"value": "19.00", "currency_code": "USD"},
                "custom_id": "POLICY_HASH_SECURE",
            },
            "_mock_verified_in_test": True,
        }
        ok, reason = self.reconciliation_gate.reconcile_capture_event(ctx, headers, body)
        self.assertTrue(ok)
        self.assertEqual(ctx.state, OrderState.SETTLEMENT_VERIFIED)
        self.assertEqual(ctx.capture_id, "CAP-LEGIT-888")

    def test_reconciliation_pending_capture_rejected(self):
        """Security: PAYMENT.CAPTURE.PENDING must NEVER unlock settlement."""
        ctx = self._prepare_approved_ctx()
        headers = {"paypal-transmission-id": "TX-PENDING-002"}
        body = {
            "event_type": "PAYMENT.CAPTURE.PENDING",
            "resource": {
                "id": "CAP-PEND-123",
                "status": "PENDING",
                "amount": {"value": "19.00", "currency_code": "USD"},
            },
            "_mock_verified_in_test": True,
        }
        ok, reason = self.reconciliation_gate.reconcile_capture_event(ctx, headers, body)
        self.assertFalse(ok)
        self.assertIn("REJECTED_EVENT_NOT_COMPLETED", reason)
        self.assertEqual(ctx.state, OrderState.FAILED)

    def test_reconciliation_amount_tampering_rejected(self):
        """Security: Amount modified in webhook (e.g. $1.00 instead of $19.00) triggers FAILED state."""
        ctx = self._prepare_approved_ctx()
        headers = {"paypal-transmission-id": "TX-FORGED-003"}
        body = {
            "event_type": "PAYMENT.CAPTURE.COMPLETED",
            "resource": {
                "id": "CAP-FORGED-456",
                "status": "COMPLETED",
                "amount": {"value": "1.00", "currency_code": "USD"}, # Forged!
                "custom_id": "POLICY_HASH_SECURE",
            },
            "_mock_verified_in_test": True,
        }
        ok, reason = self.reconciliation_gate.reconcile_capture_event(ctx, headers, body)
        self.assertFalse(ok)
        self.assertEqual(reason, "REJECTED_AMOUNT_MISMATCH")
        self.assertEqual(ctx.state, OrderState.FAILED)

    def test_reconciliation_replay_attack_rejected(self):
        """Security: Replaying the same webhook transmission ID is rejected."""
        ctx1 = self._prepare_approved_ctx()
        headers = {"paypal-transmission-id": "TX-REPLAY-UNIQUE-004"}
        body = {
            "event_type": "PAYMENT.CAPTURE.COMPLETED",
            "resource": {
                "id": "CAP-REPLAY-1",
                "status": "COMPLETED",
                "amount": {"value": "19.00", "currency_code": "USD"},
                "custom_id": "POLICY_HASH_SECURE",
            },
            "_mock_verified_in_test": True,
        }
        ok1, _ = self.reconciliation_gate.reconcile_capture_event(ctx1, headers, body)
        self.assertTrue(ok1)

        # Replay the identical transmission ID against another context
        ctx2 = self._prepare_approved_ctx()
        ok2, reason2 = self.reconciliation_gate.reconcile_capture_event(ctx2, headers, body)
        self.assertFalse(ok2)
        self.assertEqual(reason2, "REJECTED_WEBHOOK_REPLAY_ATTACK")
        self.assertEqual(ctx2.state, OrderState.FAILED)

    def test_delivery_unsettled_order_blocked(self):
        """Security: Attempting digital release on unverified/unsettled order is rejected (HTTP 401)."""
        ctx = self._prepare_approved_ctx()
        # Context is CAPTURE_COMPLETED, but not yet SETTLEMENT_VERIFIED
        token = "some_random_token"
        ok, res = self.delivery_gate.release_digital_product(ctx, token)
        self.assertFalse(ok)
        self.assertEqual(res["error"], "ACCESS_DENIED_PAYMENT_NOT_SETTLED")

    def test_delivery_valid_settlement_succeeds(self):
        """Verifies digital report release upon valid SETTLEMENT_VERIFIED state."""
        ctx = self._prepare_approved_ctx()
        ctx.transition_to(OrderState.SETTLEMENT_VERIFIED)
        ctx.capture_id = "CAP-SUCCESS-777"

        token = self.delivery_gate.generate_delivery_token(ctx)
        self.assertIsNotNone(token)

        ok, res = self.delivery_gate.release_digital_product(ctx, token)
        self.assertTrue(ok)
        self.assertEqual(res["status"], "DELIVERED_SUCCESS")
        self.assertIn("sha256_digest", res)
        self.assertEqual(len(res["sha256_digest"]), 64)
        self.assertEqual(ctx.state, OrderState.DELIVERED)

    def test_delivery_double_retrieval_blocked(self):
        """Security: Single-use delivery token cannot be re-used to download a second time."""
        ctx = self._prepare_approved_ctx()
        ctx.transition_to(OrderState.SETTLEMENT_VERIFIED)
        ctx.capture_id = "CAP-SUCCESS-777"

        token = self.delivery_gate.generate_delivery_token(ctx)
        ok1, _ = self.delivery_gate.release_digital_product(ctx, token)
        self.assertTrue(ok1)

        # Try to retrieve again with the same token
        ok2, res2 = self.delivery_gate.release_digital_product(ctx, token)
        self.assertFalse(ok2)
        self.assertEqual(res2["error"], "ACCESS_DENIED_PAYMENT_NOT_SETTLED") # State transitioned to DELIVERED, rejecting re-entry

    def test_process_restart_persistence(self):
        """
        Verifies SQLite IdempotencyRegistry survives process restarts:
        Data written by instance 1 is fully recognized by a fresh instance 2.
        """
        import tempfile
        import os
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            temp_db_path = f.name

        try:
            # Process 1 instance
            reg1 = IdempotencyRegistry(temp_db_path)
            self.assertTrue(reg1.register_request_id("REQ-RESTART-001", "ORD-101"))
            self.assertTrue(reg1.record_webhook("TX-RESTART-001", "PAYMENT.CAPTURE.COMPLETED", "ORD-101"))
            self.assertTrue(reg1.mark_token_delivered("TOKEN-RESTART-001", "ORD-101"))
            del reg1

            # Process 2 instance (simulating process restart)
            reg2 = IdempotencyRegistry(temp_db_path)
            # Duplicate request ID rejected across restart
            self.assertFalse(reg2.register_request_id("REQ-RESTART-001", "ORD-101-DUPE"))
            # Duplicate webhook detected across restart
            self.assertTrue(reg2.is_webhook_duplicate("TX-RESTART-001"))
            # Token delivery recorded across restart
            self.assertTrue(reg2.is_token_delivered("TOKEN-RESTART-001"))
        finally:
            if os.path.exists(temp_db_path):
                os.remove(temp_db_path)

    def test_concurrent_multithreaded_webhook_replay(self):
        """
        Concurrency Red Team: 10 threads concurrently recording the same webhook transmission ID.
        Exactly 1 succeeds, 9 fail with duplicate detection.
        """
        import threading
        results = []

        def worker():
            res = self.registry.record_webhook("TX-CONCURRENT-999", "PAYMENT.CAPTURE.COMPLETED", "ORD-999")
            results.append(res)

        threads = [threading.Thread(target=worker) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(results.count(True), 1)
        self.assertEqual(results.count(False), 9)

    def test_direct_capture_non_linear_transition(self):
        """
        Non-linear State Machine: Direct transition from BUYER_APPROVED to CAPTURE_COMPLETED
        (representing immediate synchronous capture returned by PayPal REST v2 API).
        """
        ctx = TransactionContext(
            session_id="SESS-DIRECT-001",
            mandate_id="MANDATE-001",
            decision_id="DEC-001",
            merchant_id="528WKSF7HVQHA",
            authorized_amount_usd="19.00",
            authorized_currency="USD",
            custom_id="POLICY_HASH_DIRECT",
            order_id="ORD-DIRECT-111",
        )
        self.assertTrue(ctx.transition_to(OrderState.ORDER_CREATED))
        self.assertTrue(ctx.transition_to(OrderState.BUYER_APPROVED))
        # Direct capture bypasses CAPTURE_PENDING
        self.assertTrue(ctx.transition_to(OrderState.CAPTURE_COMPLETED))
        self.assertEqual(ctx.state, OrderState.CAPTURE_COMPLETED)

    def test_asynchronous_out_of_order_webhook_reconciliation(self):
        """
        Asynchronous Resilience: Webhook arrives when order is in BUYER_APPROVED state
        (before client capture polling completes). State machine reconciles directly to SETTLEMENT_VERIFIED.
        """
        ctx = TransactionContext(
            session_id="SESS-ASYNC-001",
            mandate_id="MANDATE-001",
            decision_id="DEC-001",
            merchant_id="528WKSF7HVQHA",
            authorized_amount_usd="19.00",
            authorized_currency="USD",
            custom_id="POLICY_HASH_ASYNC",
            order_id="ORD-ASYNC-222",
        )
        ctx.transition_to(OrderState.ORDER_CREATED)
        ctx.transition_to(OrderState.BUYER_APPROVED)

        headers = {"paypal-transmission-id": "TX-ASYNC-001"}
        body = {
            "event_type": "PAYMENT.CAPTURE.COMPLETED",
            "resource": {
                "id": "CAP-ASYNC-222",
                "status": "COMPLETED",
                "amount": {"value": "19.00", "currency_code": "USD"},
                "custom_id": "POLICY_HASH_ASYNC",
            },
            "_mock_verified_in_test": True,
        }
        ok, reason = self.reconciliation_gate.reconcile_capture_event(ctx, headers, body)
        self.assertTrue(ok)
        self.assertEqual(ctx.state, OrderState.SETTLEMENT_VERIFIED)

    def test_capture_denied_webhook_handled(self):
        """Reconciliation handles PAYMENT.CAPTURE.DENIED webhook transitioning to CAPTURE_DENIED."""
        ctx = self._prepare_approved_ctx()
        headers = {"paypal-transmission-id": "TX-DENIED-001"}
        body = {
            "event_type": "PAYMENT.CAPTURE.DENIED",
            "resource": {"id": "CAP-DENIED-1"},
            "_mock_verified_in_test": True,
        }
        ok, reason = self.reconciliation_gate.reconcile_capture_event(ctx, headers, body)
        self.assertFalse(ok)
        self.assertEqual(reason, "REJECTED_PAYMENT_CAPTURE_DENIED")
        self.assertEqual(ctx.state, OrderState.CAPTURE_DENIED)

    def test_capture_reversed_webhook_handled(self):
        """Reconciliation handles post-settlement PAYMENT.CAPTURE.REVERSED webhook."""
        ctx = self._prepare_approved_ctx()
        headers = {"paypal-transmission-id": "TX-REVERSED-001"}
        body = {
            "event_type": "PAYMENT.CAPTURE.REVERSED",
            "resource": {"id": "CAP-REV-1"},
            "_mock_verified_in_test": True,
        }
        ok, reason = self.reconciliation_gate.reconcile_capture_event(ctx, headers, body)
        self.assertFalse(ok)
        self.assertEqual(reason, "REJECTED_PAYMENT_CAPTURE_REVERSED")
        self.assertEqual(ctx.state, OrderState.CAPTURE_REVERSED)

if __name__ == "__main__":
    unittest.main()
