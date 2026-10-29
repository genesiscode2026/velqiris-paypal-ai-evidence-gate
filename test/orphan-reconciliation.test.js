const test = require("node:test");
const assert = require("node:assert/strict");
const { createWebhookHandler } = require("../netlify/functions/paypal-webhook");
const { handler: workerHandler } = require("../netlify/functions/reconcile-worker");
const { MemoryStorageAdapter, storage } = require("../netlify/functions/storage-adapter");

// Programmatic test harness handler with injected verifier and tokenSecret
const webhookHandler = createWebhookHandler({
  verifier: async () => ({ ok: true, method: "LOCAL_TEST_HARNESS_VERIFIED" }),
  tokenSecret: "TEST_SECRET_RECON_98765"
});

test("GATE W: Orphan Webhook arrives before local order creation -> returns 202 PENDING_RECONCILIATION without delivery token", async () => {
  const orphanOrderId = "ORD-ORPHAN-001";
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-ORPHAN-ARRIVAL-001",
      "paypal-transmission-time": "2026-10-28T21:00:00Z",
      "paypal-transmission-sig": "test_sig_mock",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/cert",
      "paypal-auth-algo": "SHA256withRSA"
    },
    body: JSON.stringify({
      id: "WH-EVT-ORPHAN-001",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-ORPHAN-001",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "POL_AUDIT_ORPHAN_001",
        supplementary_data: { related_ids: { order_id: orphanOrderId } }
      }
    })
  };

  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 202, "Orphan webhook must return HTTP 202 Accepted");
  const data = JSON.parse(res.body);
  assert.equal(data.status, "RECORDED_PENDING_RECONCILIATION");
  assert.equal(data.order_id, orphanOrderId);
  assert.equal(data.delivery_token_issued, undefined, "Zero delivery token can be issued before order reconciliation");
});

test("GATE W: Order is created locally -> Worker reconciles orphan webhook and issues delivery token", async () => {
  const orphanOrderId = "ORD-ORPHAN-RECON-002";
  const storage = new MemoryStorageAdapter();

  // 1. Webhook arrives first
  await storage.recordWebhookInbox({
    transmission_id: "TX-ORPHAN-RECON-002",
    event_id: "EVT-RECON-002",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    order_id: orphanOrderId,
    capture_id: "CAP-ORPHAN-RECON-002",
    verification_status: "SUCCESS",
    verification_method: "PAYPAL_API_VERIFY",
    processing_status: "PENDING_RECONCILIATION",
    payload_sha256: "hashrecon002",
    raw_payload: {
      id: "EVT-RECON-002",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-ORPHAN-RECON-002",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "POL_AUDIT_RECON_002"
      }
    }
  });

  // 2. Order created locally
  await storage.createPayPalOrder({
    order_id: orphanOrderId,
    intent_id: "INTENT-RECON-002",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "POL_AUDIT_RECON_002",
    status: "CREATED"
  });

  // 3. Trigger reconciliation
  const reconResult = await storage.reconcileOrphanWebhooks(orphanOrderId);
  assert.equal(reconResult.reconciled, true);
  assert.equal(reconResult.count, 1);
  assert.ok(reconResult.results[0].delivery_token);

  // 4. Verify order is now COMPLETED
  const updatedOrder = await storage.getPayPalOrder(orphanOrderId);
  assert.equal(updatedOrder.status, "COMPLETED");

  // 5. Verify single-use delivery token works
  const token = reconResult.results[0].delivery_token;
  const delivery = await storage.consumeDeliveryAuthorizationAtomic(token);
  assert.equal(delivery.success, true);
  assert.equal(delivery.status, "DELIVERED_SUCCESS");

  // Second download fails
  const delivery2 = await storage.consumeDeliveryAuthorizationAtomic(token);
  assert.equal(delivery2.success, false);
});

test("GATE W: Unreconcilable orphan webhook (amount mismatch) is quarantined to DLQ", async () => {
  const orphanOrderId = "ORD-ORPHAN-MISMATCH-003";
  const storage = new MemoryStorageAdapter();

  // Webhook has tampered price $99.00
  await storage.recordWebhookInbox({
    transmission_id: "TX-ORPHAN-MISMATCH-003",
    event_id: "EVT-MISMATCH-003",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    order_id: orphanOrderId,
    capture_id: "CAP-MISMATCH-003",
    verification_status: "SUCCESS",
    verification_method: "PAYPAL_API_VERIFY",
    processing_status: "PENDING_RECONCILIATION",
    payload_sha256: "hashmismatch003",
    raw_payload: {
      id: "EVT-MISMATCH-003",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-MISMATCH-003",
        status: "COMPLETED",
        amount: { value: "99.00", currency_code: "USD" },
        custom_id: "POL_AUDIT_003"
      }
    }
  });

  // Local order was authorized for $19.00
  await storage.createPayPalOrder({
    order_id: orphanOrderId,
    intent_id: "INTENT-003",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "POL_AUDIT_003",
    status: "CREATED"
  });

  // Reconcile
  const reconResult = await storage.reconcileOrphanWebhooks(orphanOrderId);
  assert.equal(reconResult.reconciled, true);
  assert.equal(reconResult.results[0].status, "QUARANTINED_TO_DLQ");

  // Check DLQ
  const dlq = await storage.getDLQItems();
  const quarantined = dlq.find(d => d.transmission_id === "TX-ORPHAN-MISMATCH-003");
  assert.ok(quarantined, "Unreconcilable orphan must exist in DLQ");
  assert.equal(quarantined.failure_reason, "RECONCILIATION_FINANCIAL_MISMATCH");

  // Order status must NOT be COMPLETED
  const order = await storage.getPayPalOrder(orphanOrderId);
  assert.notEqual(order.status, "COMPLETED");
});

test("GATE X: Asynchronous Worker leases and completes transactional outbox items", async () => {
  const storage = new MemoryStorageAdapter();

  await storage.enqueueOutbox({
    aggregate_type: "ORDER",
    aggregate_id: "ORD-TEST-004",
    event_type: "TEST_NOTIFICATION",
    payload: { info: "Delivery ready" }
  });

  const lease = await storage.leaseOutboxBatch(5, 10000);
  assert.equal(lease.items.length, 1);
  assert.equal(lease.items[0].status, "PROCESSING");

  const completed = await storage.completeOutboxItem(lease.items[0].id, lease.leaseToken);
  assert.equal(completed, true);
});

test("GATE AN: Retransmission of already durably committed webhook returns HTTP 200 ALREADY_PROCESSED_IDEMPOTENT_OK", async () => {
  const orderId = "ORD-COMMITTED-005";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-005",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "POL_AUDIT_005",
    status: "CREATED"
  });

  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-DURABLE-COMMITTED-RETRY-005",
      "paypal-transmission-time": "2026-10-28T21:10:00Z",
      "paypal-transmission-sig": "test_sig_mock",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/cert",
      "paypal-auth-algo": "SHA256withRSA"
    },
    body: JSON.stringify({
      id: "WH-EVT-COMMITTED-005",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-COMMITTED-005",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "POL_AUDIT_005",
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };

  // First transmission -> 200 PAYPAL_SETTLEMENT_VERIFIED
  const res1 = await webhookHandler(req);
  assert.equal(res1.statusCode, 200);
  const data1 = JSON.parse(res1.body);
  assert.equal(data1.status, "PAYPAL_SETTLEMENT_VERIFIED");

  // Subsequent retransmission -> 200 ALREADY_PROCESSED_IDEMPOTENT_OK
  const res2 = await webhookHandler(req);
  assert.equal(res2.statusCode, 200);
  const data2 = JSON.parse(res2.body);
  assert.equal(data2.status, "ALREADY_PROCESSED_IDEMPOTENT_OK");
  assert.equal(data2.transmission_id, "TX-DURABLE-COMMITTED-RETRY-005");
});
