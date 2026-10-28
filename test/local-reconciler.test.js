const test = require("node:test");
const assert = require("node:assert/strict");
const { LocalReconciler } = require("../local-reconciler");
const { PostgresStorageAdapter } = require("../netlify/functions/storage-adapter");

const TEST_DB_URL = "postgresql://velqiris_admin:velqiris_test_password_2026@127.0.0.1:5432/velqiris_test_db";

test("GATE AM: LocalReconciler handles orphan webhook arrival and delayed reconciliation cycle", async () => {
  const adapter = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const reconciler = new LocalReconciler({ storage: adapter, pollIntervalMs: 500 });
  const orderId = `ORD-REC-LOCAL-${Date.now()}`;
  const txId = `TX-REC-LOCAL-${Date.now()}`;
  const capId = `CAP-REC-LOCAL-${Date.now()}`;
  const mandateId = `MANDATE-REC-${Date.now()}`;
  const intentId = `INTENT-REC-${Date.now()}`;
  const policyHash = `POLHASH_REC_${Date.now()}`;

  try {
    // 1. Webhook arrives first
    await adapter.recordWebhookInbox({
      transmission_id: txId,
      event_id: `EVT-${Date.now()}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      order_id: orderId,
      capture_id: capId,
      verification_status: "SUCCESS",
      verification_method: "PAYPAL_API_VERIFY",
      processing_status: "PENDING_RECONCILIATION",
      payload_sha256: "hash123",
      raw_payload: {
        id: `EVT-${Date.now()}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: capId,
          status: "COMPLETED",
          amount: { value: "19.00", currency_code: "USD" },
          custom_id: policyHash,
          supplementary_data: { related_ids: { order_id: orderId } }
        }
      }
    });

    // 2. Run cycle before order exists -> 0 reconciled
    const cycle1 = await reconciler.runCycle();
    assert.equal(cycle1.orphansReconciled, 0);

    // 3. Register local order
    await adapter.recordMandate({
      mandate_id: mandateId,
      title: "Local Reconciler Test Mandate",
      max_budget_usd: 25.00,
      max_tolerable_risk_score: 30.0,
      authorized_merchants: ["MERCH-LOCAL"]
    });

    await adapter.createPurchaseIntent({
      intent_id: intentId,
      mandate_id: mandateId,
      recommended_offer_id: "OFF-LOCAL",
      vendor_name: "Local Vendor",
      merchant_id: "MERCH-LOCAL",
      proposed_price_usd: 19.00,
      quality_score: 90.0,
      risk_score: 10.0,
      uncertainty_score: 0.05,
      confidence_score: 0.95,
      utility_score: 0.85,
      decision_rationale: "Approved",
      engine_mode: "DEMO_DETERMINISTIC_ONLY",
      injection_detected: false,
      policy_approved: true,
      policy_verdict_code: "POLICY_APPROVED",
      policy_audit_sha256: policyHash
    });

    await adapter.createPayPalOrder({
      order_id: orderId,
      intent_id: intentId,
      mandate_id: mandateId,
      merchant_id: "MERCH-LOCAL",
      amount_usd: 19.00,
      currency: "USD",
      custom_id: policyHash,
      status: "CREATED"
    });

    // 4. Run cycle after order exists -> automatically reconciles!
    const cycle2 = await reconciler.runCycle();
    assert.equal(cycle2.orphansReconciled, 1, "Orphan webhook must be reconciled by the daemon");

    // 5. Verify order is COMPLETED
    const order = await adapter.getPayPalOrder(orderId);
    assert.equal(order.status, "COMPLETED");

    // 6. Verify health metrics
    const health = reconciler.getHealth();
    assert.ok(health.cycles_completed >= 2);
    assert.equal(health.orphans_reconciled_total, 1);
  } finally {
    await adapter.close();
  }
});

test("GATE AM: Two concurrent LocalReconciler instances lease disjoint outbox partitions without race", async () => {
  const adapter1 = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const adapter2 = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const rec1 = new LocalReconciler({ storage: adapter1 });
  const rec2 = new LocalReconciler({ storage: adapter2 });
  const aggId = `AGG-CONC-WORKER-${Date.now()}`;

  try {
    // Enqueue 2 outbox items
    await adapter1.enqueueOutbox({
      aggregate_type: "ORDER",
      aggregate_id: aggId,
      event_type: "CONCURRENT_TEST_1",
      payload: { n: 1 }
    });
    await adapter1.enqueueOutbox({
      aggregate_type: "ORDER",
      aggregate_id: aggId,
      event_type: "CONCURRENT_TEST_2",
      payload: { n: 2 }
    });

    // Run cycles concurrently
    const [cycle1, cycle2] = await Promise.all([
      rec1.runCycle(),
      rec2.runCycle()
    ]);

    const totalProcessed = cycle1.outboxProcessed + cycle2.outboxProcessed;
    assert.equal(totalProcessed, 2, "Both items must be processed across the two workers");

    // Neither worker failed
    assert.equal(cycle1.outboxFailed, 0);
    assert.equal(cycle2.outboxFailed, 0);
  } finally {
    await adapter1.close();
    await adapter2.close();
  }
});

test("GATE AM: Graceful shutdown completes in-flight cycle before stopping", async () => {
  const adapter = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const reconciler = new LocalReconciler({ storage: adapter, pollIntervalMs: 100 });

  try {
    await reconciler.start();
    assert.equal(reconciler.isRunning, true);

    // Wait 250ms for at least one cycle
    await new Promise(r => setTimeout(r, 250));

    // Request stop
    await reconciler.stop();
    assert.equal(reconciler.isRunning, false);
    assert.equal(reconciler.getHealth().status, "STOPPED");
    assert.ok(reconciler.getHealth().cycles_completed >= 1);
  } finally {
    await adapter.close();
  }
});
