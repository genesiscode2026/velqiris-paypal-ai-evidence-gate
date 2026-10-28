const test = require("node:test");
const assert = require("node:assert/strict");
const { PostgresStorageAdapter } = require("../netlify/functions/storage-adapter");

const TEST_DB_URL = "postgresql://velqiris_admin:velqiris_test_password_2026@127.0.0.1:5432/velqiris_test_db";

test("POSTGRES REAL INTEGRATION: Connects to real local PostgreSQL and verifies 12 tables", async () => {
  const adapter = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  try {
    const res = await adapter.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const tables = res.rows.map(r => r.table_name);
    assert.ok(tables.includes("procurement_mandates"), "procurement_mandates must exist");
    assert.ok(tables.includes("purchase_intents"), "purchase_intents must exist");
    assert.ok(tables.includes("paypal_orders"), "paypal_orders must exist");
    assert.ok(tables.includes("paypal_captures"), "paypal_captures must exist");
    assert.ok(tables.includes("webhook_events"), "webhook_events must exist");
    assert.ok(tables.includes("webhook_inbox"), "webhook_inbox must exist");
    assert.ok(tables.includes("transactional_outbox"), "transactional_outbox must exist");
    assert.ok(tables.includes("dead_letter_queue"), "dead_letter_queue must exist");
    assert.ok(tables.includes("idempotency_keys"), "idempotency_keys must exist");
    assert.ok(tables.includes("delivery_authorizations"), "delivery_authorizations must exist");
    assert.ok(tables.includes("delivery_artifacts"), "delivery_artifacts must exist");
    assert.ok(tables.includes("audit_events"), "audit_events must exist");
  } finally {
    await adapter.close();
  }
});

test("POSTGRES REAL INTEGRATION: Transactions - Rollback cleanly discards partial writes", async () => {
  const adapter = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const testOrderId = `ORD-ROLLBACK-TEST-${Date.now()}`;
  try {
    let threw = false;
    try {
      await adapter.withTransaction(async (client) => {
        // Step 1: Insert mandate
        await client.query(
          `INSERT INTO procurement_mandates (mandate_id, title, max_budget_usd, currency, max_tolerable_risk_score, authorized_merchants)
           VALUES ($1, 'Rollback Test Mandate', 25.00, 'USD', 30.0, '[]')`,
          [`MANDATE-${testOrderId}`]
        );
        // Step 2: Intentional error to trigger rollback
        throw new Error("INTENTIONAL_CRASH_BEFORE_COMMIT");
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /INTENTIONAL_CRASH_BEFORE_COMMIT/);
    }
    assert.equal(threw, true);

    // Verify row was NOT persisted
    const check = await adapter.pool.query(
      "SELECT * FROM procurement_mandates WHERE mandate_id = $1",
      [`MANDATE-${testOrderId}`]
    );
    assert.equal(check.rows.length, 0, "Partial write must be rolled back");
  } finally {
    await adapter.close();
  }
});

test("POSTGRES REAL INTEGRATION: Concurrency - Two connections inserting distinct records commit without race", async () => {
  const adapter1 = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const adapter2 = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const id1 = `MANDATE-CONC-1-${Date.now()}`;
  const id2 = `MANDATE-CONC-2-${Date.now()}`;
  try {
    const [res1, res2] = await Promise.all([
      adapter1.recordMandate({
        mandate_id: id1,
        title: "Concurrent Mandate 1",
        max_budget_usd: 25.00,
        max_tolerable_risk_score: 30.0,
        authorized_merchants: ["MERCH-1"]
      }),
      adapter2.recordMandate({
        mandate_id: id2,
        title: "Concurrent Mandate 2",
        max_budget_usd: 50.00,
        max_tolerable_risk_score: 20.0,
        authorized_merchants: ["MERCH-2"]
      })
    ]);
    assert.equal(res1.mandate_id, id1);
    assert.equal(res2.mandate_id, id2);

    const m1 = await adapter1.getMandate(id1);
    const m2 = await adapter2.getMandate(id2);
    assert.equal(m1.max_budget_usd, 25.00);
    assert.equal(m2.max_budget_usd, 50.00);
  } finally {
    await adapter1.close();
    await adapter2.close();
  }
});

test("POSTGRES REAL INTEGRATION: Unique constraint violation is enforced by PostgreSQL engine", async () => {
  const adapter = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const uniqueId = `MANDATE-UNIQUE-FAIL-${Date.now()}`;
  try {
    await adapter.pool.query(
      `INSERT INTO procurement_mandates (mandate_id, title, max_budget_usd, currency, max_tolerable_risk_score, authorized_merchants)
       VALUES ($1, 'Original Mandate', 25.00, 'USD', 30.0, '[]')`,
      [uniqueId]
    );

    let threw = false;
    try {
      await adapter.pool.query(
        `INSERT INTO procurement_mandates (mandate_id, title, max_budget_usd, currency, max_tolerable_risk_score, authorized_merchants)
         VALUES ($1, 'Duplicate Mandate', 25.00, 'USD', 30.0, '[]')`,
        [uniqueId]
      );
    } catch (err) {
      threw = true;
      assert.match(err.code, /23505/, "PostgreSQL 23505 unique_violation expected");
    }
    assert.equal(threw, true);
  } finally {
    await adapter.close();
  }
});

test("POSTGRES REAL INTEGRATION: Transactional Outbox leasing with FOR UPDATE SKIP LOCKED", async () => {
  const adapter1 = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const adapter2 = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const aggId = `AGG-OUTBOX-${Date.now()}`;
  try {
    // Enqueue 2 outbox items
    await adapter1.enqueueOutbox({
      aggregate_type: "ORDER",
      aggregate_id: aggId,
      event_type: "ITEM_1",
      payload: { test: 1 }
    });
    await adapter1.enqueueOutbox({
      aggregate_type: "ORDER",
      aggregate_id: aggId,
      event_type: "ITEM_2",
      payload: { test: 2 }
    });

    // Two concurrent workers lease items simultaneously
    const [lease1, lease2] = await Promise.all([
      adapter1.leaseOutboxBatch(1, 10000),
      adapter2.leaseOutboxBatch(1, 10000)
    ]);

    // SKIP LOCKED guarantees that Worker 1 and Worker 2 get disjoint items!
    assert.equal(lease1.items.length, 1);
    assert.equal(lease2.items.length, 1);
    assert.notEqual(lease1.items[0].id, lease2.items[0].id, "Workers must receive disjoint outbox items");

    // Complete item 1, fail item 2
    await adapter1.completeOutboxItem(lease1.items[0].id, lease1.leaseToken);
    await adapter2.failOutboxItem(lease2.items[0].id, lease2.leaseToken, "Simulated transient worker failure");
  } finally {
    await adapter1.close();
    await adapter2.close();
  }
});

test("POSTGRES REAL INTEGRATION: Dead Letter Queue (DLQ) quarantines unrecoverable event", async () => {
  const adapter = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const txId = `TX-DLQ-REAL-${Date.now()}`;
  try {
    const dlqItem = await adapter.quarantineToDLQ({
      event_id: `EVT-DLQ-${Date.now()}`,
      transmission_id: txId,
      failure_reason: "PERSISTENT_CORRUPTED_PAYLOAD",
      attempt_count: 5,
      last_error_redacted: "SyntaxError: Unexpected token in JSON payload"
    });
    assert.ok(dlqItem.id > 0);
    assert.equal(dlqItem.review_status, "UNREVIEWED");

    const items = await adapter.getDLQItems();
    const found = items.find(i => i.transmission_id === txId);
    assert.ok(found);
    assert.equal(found.failure_reason, "PERSISTENT_CORRUPTED_PAYLOAD");
  } finally {
    await adapter.close();
  }
});

test("POSTGRES REAL INTEGRATION: Orphan Webhook arrives before order, stored PENDING_RECONCILIATION, then reconciled", async () => {
  const adapter = new PostgresStorageAdapter({ connectionString: TEST_DB_URL });
  const testOrderId = `ORD-ORPHAN-${Date.now()}`;
  const testTxId = `TX-ORPHAN-${Date.now()}`;
  const testCapId = `CAP-ORPHAN-${Date.now()}`;
  const testMandateId = `MANDATE-ORPHAN-${Date.now()}`;
  const testIntentId = `INTENT-ORPHAN-${Date.now()}`;
  const testPolicyHash = `POLHASH${Date.now()}`;
  try {
    // 1. Webhook arrives BEFORE local order exists
    const inboxRes = await adapter.recordWebhookInbox({
      transmission_id: testTxId,
      event_id: `EVT-${Date.now()}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      order_id: testOrderId,
      capture_id: testCapId,
      verification_status: "SUCCESS",
      verification_method: "PAYPAL_API_VERIFY",
      processing_status: "PENDING_RECONCILIATION",
      payload_sha256: "hash123",
      raw_payload: {
        id: `EVT-${Date.now()}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: testCapId,
          status: "COMPLETED",
          amount: { value: "19.00", currency_code: "USD" },
          custom_id: testPolicyHash,
          supplementary_data: { related_ids: { order_id: testOrderId } }
        }
      }
    });
    assert.equal(inboxRes.is_duplicate, false);

    // Verify inbox item is PENDING_RECONCILIATION
    const inboxItem = await adapter.getWebhookInbox(testTxId);
    assert.equal(inboxItem.processing_status, "PENDING_RECONCILIATION");

    // 2. Local order arrives and is recorded in PostgreSQL
    await adapter.recordMandate({
      mandate_id: testMandateId,
      title: "Orphan Reconcile Mandate",
      max_budget_usd: 25.00,
      max_tolerable_risk_score: 30.0,
      authorized_merchants: ["MERCH-ALPHA"]
    });

    await adapter.createPurchaseIntent({
      intent_id: testIntentId,
      mandate_id: testMandateId,
      recommended_offer_id: "OFFER-1",
      vendor_name: "Alpha Corp",
      merchant_id: "MERCH-ALPHA",
      proposed_price_usd: 19.00,
      quality_score: 95.0,
      risk_score: 12.0,
      uncertainty_score: 0.05,
      confidence_score: 0.95,
      utility_score: 0.90,
      decision_rationale: "Approved",
      engine_mode: "DEMO_DETERMINISTIC_ONLY",
      injection_detected: false,
      policy_approved: true,
      policy_verdict_code: "POLICY_APPROVED",
      policy_audit_sha256: testPolicyHash
    });

    await adapter.createPayPalOrder({
      order_id: testOrderId,
      intent_id: testIntentId,
      mandate_id: testMandateId,
      merchant_id: "MERCH-ALPHA",
      amount_usd: 19.00,
      currency: "USD",
      custom_id: testPolicyHash,
      status: "CREATED"
    });

    // 3. Trigger reconciliation
    const reconResult = await adapter.reconcileOrphanWebhooks(testOrderId);
    assert.equal(reconResult.reconciled, true);
    assert.equal(reconResult.count, 1);
    assert.ok(reconResult.results[0].delivery_token);

    // 4. Verify order is now COMPLETED and inbox item is PROCESSED
    const updatedOrder = await adapter.getPayPalOrder(testOrderId);
    assert.equal(updatedOrder.status, "COMPLETED");

    const updatedInbox = await adapter.getWebhookInbox(testTxId);
    assert.equal(updatedInbox.processing_status, "PROCESSED");

    // 5. Verify single-use delivery token can be consumed exactly once
    const consume1 = await adapter.consumeDeliveryAuthorizationAtomic(reconResult.results[0].delivery_token);
    assert.equal(consume1.success, true);
    assert.equal(consume1.status, "DELIVERED_SUCCESS");

    const consume2 = await adapter.consumeDeliveryAuthorizationAtomic(reconResult.results[0].delivery_token);
    assert.equal(consume2.success, false);
    assert.equal(consume2.error, "TOKEN_ALREADY_CONSUMED");
  } finally {
    await adapter.close();
  }
});
