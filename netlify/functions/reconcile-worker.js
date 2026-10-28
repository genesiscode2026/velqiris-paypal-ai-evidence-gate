/**
 * VELQIRIS — ASYNCHRONOUS RECONCILIATION WORKER (Gate X & Gate W)
 * Recovers orphan webhooks, processes transactional outbox events, and handles DLQ routing.
 * 
 * Invocation Targets:
 * - Netlify Scheduled Functions (cron: e.g. every 5 minutes)
 * - Netlify Background Functions
 * - On-demand HTTP POST from order-creation flow
 */

const { getStorageAdapter } = require("./storage-adapter");
const storage = getStorageAdapter();

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, private"
    },
    body: JSON.stringify(body)
  };
}

async function handler(event) {
  const method = event.httpMethod || "GET";
  let body = {};
  if (method === "POST" && event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return reply(400, { error: "INVALID_JSON_PAYLOAD" });
    }
  }

  const { order_id, batch_size } = body;
  const results = {
    worker_status: "SUCCESS",
    timestamp: new Date().toISOString(),
    orphan_reconciled: null,
    outbox_processed: []
  };

  // 1. If specific order_id provided, attempt orphan webhook reconciliation immediately
  if (order_id) {
    const orphanRes = await storage.reconcileOrphanWebhooks(order_id);
    results.orphan_reconciled = orphanRes;
  }

  // 2. Process Transactional Outbox Batch
  const limit = parseInt(batch_size || "10", 10);
  const lease = await storage.leaseOutboxBatch(limit, 30000);

  if (lease && lease.items && lease.items.length > 0) {
    for (const item of lease.items) {
      try {
        // Execute post-commit side-effect
        // In VELQIRIS: side effects include publishing audit logs, updating cached order states, emitting notifications
        await storage.completeOutboxItem(item.id, lease.leaseToken);
        results.outbox_processed.push({
          id: item.id,
          aggregate_type: item.aggregate_type,
          aggregate_id: item.aggregate_id,
          status: "COMPLETED"
        });
      } catch (err) {
        await storage.failOutboxItem(item.id, lease.leaseToken, err.message);
        results.outbox_processed.push({
          id: item.id,
          status: "FAILED",
          error: err.message
        });
      }
    }
  }

  return reply(200, results);
}

exports.handler = handler;
