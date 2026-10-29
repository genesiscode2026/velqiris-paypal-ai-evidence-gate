/**
 * VELQIRIS — TRANSACTIONAL STORAGE ADAPTER
 * Canonical single source of truth for financial transactions, mandates, webhooks, and single-use digital deliveries.
 * 
 * Topologies Supported:
 * 1. PostgresStorageAdapter: Connects to PostgreSQL via DATABASE_URL or connection parameters.
 *    Supports transactions via dedicated client checkout (BEGIN ... COMMIT / ROLLBACK),
 *    PostgreSQL row-level locking (FOR UPDATE SKIP LOCKED) for the Outbox worker,
 *    and foreign-key enforced multi-table atomic updates.
 * 2. MemoryStorageAdapter: Fully isolated transactional adapter for tests & CI/CD.
 * 
 * Hosting Governance:
 * Cloud-managed DB activation is BLOCKED_PENDING_AUTHORIZATION to prevent unapproved infrastructure costs.
 */

const crypto = require("crypto");
let pg;
try {
  pg = require("pg");
} catch {
  pg = null;
}

const STORAGE_HOSTED_STATUS = "BLOCKED_PENDING_AUTHORIZATION";

// ==============================================================================
// 1. MEMORY STORAGE ADAPTER (In-Memory Transactional Engine for Tests)
// ==============================================================================
class MemoryStorageAdapter {
  constructor() {
    this._tables = {
      procurement_mandates: new Map(),
      purchase_intents: new Map(),
      paypal_orders: new Map(),
      paypal_captures: new Map(),
      webhook_events: new Map(),
      webhook_inbox: new Map(),
      transactional_outbox: [],
      dead_letter_queue: [],
      idempotency_keys: new Map(),
      delivery_authorizations: new Map(),
      delivery_artifacts: new Map(),
      audit_events: []
    };
    this._outboxSeq = 1;
    this._dlqSeq = 1;
    this._initDefaultMandate();
  }

  _initDefaultMandate() {
    const mandate = {
      mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
      title: "Digital Market Intelligence Autonomous Procurement Mandate",
      max_budget_usd: 25.00,
      currency: "USD",
      max_tolerable_risk_score: 30.0,
      authorized_merchants: [
        "528WKSF7HVQHA",
        "MERCH-ALPHA-01",
        "MERCH-BETA-02",
        "MERCH-GAMMA-03"
      ],
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1
    };
    this._tables.procurement_mandates.set(mandate.mandate_id, mandate);
  }

  async getMandate(mandateId) {
    return this._tables.procurement_mandates.get(mandateId) || null;
  }

  async createPurchaseIntent(intent) {
    if (this._tables.purchase_intents.has(intent.intent_id)) {
      throw new Error(`UNIQUE_CONSTRAINT_VIOLATION: intent_id '${intent.intent_id}' already exists.`);
    }
    for (const item of this._tables.purchase_intents.values()) {
      if (item.policy_audit_sha256 === intent.policy_audit_sha256) {
        throw new Error(`UNIQUE_CONSTRAINT_VIOLATION: policy_audit_sha256 already recorded.`);
      }
    }
    const record = { ...intent, created_at: new Date().toISOString() };
    this._tables.purchase_intents.set(intent.intent_id, record);
    this._recordAudit({
      entity_type: "PURCHASE_INTENT",
      entity_id: intent.intent_id,
      action: "INTENT_CREATED",
      actor: "POLICY_GATE",
      details: { verdict: intent.policy_verdict_code, approved: intent.policy_approved }
    });
    return record;
  }

  async createPayPalOrder(order, idempotencyKey) {
    if (idempotencyKey) {
      if (this._tables.idempotency_keys.has(idempotencyKey)) {
        return { is_duplicate: true, existing: this._tables.idempotency_keys.get(idempotencyKey).response_payload };
      }
    }
    if (this._tables.paypal_orders.has(order.order_id)) {
      throw new Error(`UNIQUE_CONSTRAINT_VIOLATION: order_id '${order.order_id}' already exists.`);
    }
    const record = {
      ...order,
      status: order.status || "CREATED",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1
    };
    this._tables.paypal_orders.set(order.order_id, record);
    if (idempotencyKey) {
      this._tables.idempotency_keys.set(idempotencyKey, {
        request_key: idempotencyKey,
        scope: "CREATE_ORDER",
        resource_id: order.order_id,
        response_payload: record,
        expires_at: new Date(Date.now() + 86400000).toISOString()
      });
    }
    this._recordAudit({
      entity_type: "ORDER",
      entity_id: order.order_id,
      action: "ORDER_CREATED",
      actor: "PAYPAL_PROCESSOR",
      details: { amount_usd: order.amount_usd, custom_id: order.custom_id }
    });
    return { is_duplicate: false, order: record };
  }

  async getPayPalOrder(orderId) {
    return this._tables.paypal_orders.get(orderId) || null;
  }

  async recordWebhookEvent(event) {
    if (this._tables.webhook_events.has(event.transmission_id)) {
      return { is_duplicate: true, status: "REPLAY_REJECTED" };
    }
    const record = {
      ...event,
      received_at: new Date().toISOString(),
      processed_status: "PROCESSED"
    };
    this._tables.webhook_events.set(event.transmission_id, record);
    this._recordAudit({
      entity_type: "WEBHOOK",
      entity_id: event.transmission_id,
      action: "WEBHOOK_VERIFIED_AND_RECORDED",
      actor: "PAYPAL_WEBHOOK",
      details: { event_type: event.event_type, resource_id: event.resource_id, verification: event.verification_status }
    });
    return { is_duplicate: false, event: record };
  }

  async isWebhookDuplicate(transmissionId) {
    return this._tables.webhook_events.has(transmissionId) || this._tables.webhook_inbox.has(transmissionId);
  }

  // --- GATE V: Durable Webhook Inbox ---
  async recordWebhookInbox(inboxEntry) {
    if (this._tables.webhook_inbox.has(inboxEntry.transmission_id)) {
      return { is_duplicate: true, existing: this._tables.webhook_inbox.get(inboxEntry.transmission_id) };
    }
    const record = {
      ...inboxEntry,
      processing_status: inboxEntry.processing_status || "RECEIVED",
      attempt_count: inboxEntry.attempt_count || 0,
      received_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this._tables.webhook_inbox.set(inboxEntry.transmission_id, record);
    this._recordAudit({
      entity_type: "WEBHOOK_INBOX",
      entity_id: inboxEntry.transmission_id,
      action: `INBOX_RECORDED_${record.processing_status}`,
      actor: "PAYPAL_INGRESS",
      details: { event_id: inboxEntry.event_id, order_id: inboxEntry.order_id, capture_id: inboxEntry.capture_id }
    });
    return { is_duplicate: false, record };
  }

  async getWebhookInbox(transmissionId) {
    return this._tables.webhook_inbox.get(transmissionId) || null;
  }

  async updateWebhookInboxStatus(transmissionId, status, errorMsg = null) {
    const item = this._tables.webhook_inbox.get(transmissionId);
    if (!item) return false;
    item.processing_status = status;
    item.updated_at = new Date().toISOString();
    item.attempt_count = (item.attempt_count || 0) + 1;
    if (errorMsg) item.last_error = errorMsg;
    return true;
  }

  // --- GATE V: Transactional Outbox ---
  async enqueueOutbox(action, externalClient = null) {
    const record = {
      id: this._outboxSeq++,
      aggregate_type: action.aggregate_type,
      aggregate_id: action.aggregate_id,
      event_type: action.event_type,
      payload: action.payload,
      status: "PENDING",
      retry_count: 0,
      max_retries: action.max_retries || 5,
      next_retry_at: new Date().toISOString(),
      lease_token: null,
      lease_expires_at: null,
      created_at: new Date().toISOString(),
      processed_at: null
    };
    this._tables.transactional_outbox.push(record);
    return record;
  }

  async leaseOutboxBatch(batchSize = 10, leaseDurationMs = 30000) {
    const now = Date.now();
    const leaseToken = crypto.randomBytes(16).toString("hex");
    const leased = [];

    for (const item of this._tables.transactional_outbox) {
      if (leased.length >= batchSize) break;
      const isExpired = item.lease_expires_at && new Date(item.lease_expires_at).getTime() < now;
      if (item.status === "PENDING" || (item.status === "PROCESSING" && isExpired)) {
        item.status = "PROCESSING";
        item.lease_token = leaseToken;
        item.lease_expires_at = new Date(now + leaseDurationMs).toISOString();
        item.retry_count += 1;
        leased.push({ ...item });
      }
    }
    return { leaseToken, items: leased };
  }

  async completeOutboxItem(id, leaseToken) {
    const item = this._tables.transactional_outbox.find(i => i.id === id);
    if (!item) return false;
    if (leaseToken && item.lease_token !== leaseToken) return false;
    item.status = "COMPLETED";
    item.processed_at = new Date().toISOString();
    item.lease_token = null;
    item.lease_expires_at = null;
    return true;
  }

  async failOutboxItem(id, leaseToken, errorMsg) {
    const item = this._tables.transactional_outbox.find(i => i.id === id);
    if (!item) return false;
    if (leaseToken && item.lease_token !== leaseToken) return false;
    if (item.retry_count >= item.max_retries) {
      item.status = "FAILED";
      // Route to DLQ
      await this.quarantineToDLQ({
        event_id: `OUTBOX-${item.id}`,
        transmission_id: `AGG-${item.aggregate_id}`,
        failure_reason: `MAX_RETRIES_EXCEEDED: ${errorMsg}`,
        attempt_count: item.retry_count,
        last_error_redacted: errorMsg
      });
    } else {
      item.status = "PENDING";
      item.next_retry_at = new Date(Date.now() + 5000 * item.retry_count).toISOString();
    }
    item.lease_token = null;
    item.lease_expires_at = null;
    return true;
  }

  // --- GATE V: Dead Letter Queue (DLQ) ---
  async quarantineToDLQ(entry) {
    const record = {
      id: this._dlqSeq++,
      event_id: entry.event_id,
      transmission_id: entry.transmission_id,
      failure_reason: entry.failure_reason,
      attempt_count: entry.attempt_count || 1,
      last_error_redacted: entry.last_error_redacted || "Redacted error trace",
      quarantined_at: new Date().toISOString(),
      review_status: "UNREVIEWED"
    };
    this._tables.dead_letter_queue.push(record);
    this._recordAudit({
      entity_type: "DLQ",
      entity_id: entry.transmission_id,
      action: "QUARANTINED_TO_DLQ",
      actor: "RECOVERY_WORKER",
      details: { reason: entry.failure_reason, attempts: record.attempt_count }
    });
    return record;
  }

  async getDLQItems() {
    return [...this._tables.dead_letter_queue];
  }

  // --- GATE W: Orphan Webhook Reconciliation ---
  async reconcileOrphanWebhooks(orderId) {
    const order = await this.getPayPalOrder(orderId);
    if (!order) return { reconciled: false, reason: "ORDER_NOT_FOUND" };

    // Find pending inbox events for this order
    const pendingEvents = Array.from(this._tables.webhook_inbox.values()).filter(
      item => (item.order_id === orderId || (item.raw_payload?.resource?.supplementary_data?.related_ids?.order_id === orderId)) &&
              item.processing_status === "PENDING_RECONCILIATION"
    );

    if (pendingEvents.length === 0) {
      return { reconciled: false, count: 0, reason: "NO_PENDING_ORPHAN_EVENTS" };
    }

    const results = [];
    for (const event of pendingEvents) {
      const resource = event.raw_payload?.resource || {};
      const capturedAmount = resource.amount?.value;
      const capturedCurrency = resource.amount?.currency_code;
      const customId = resource.custom_id;

      // Gate 7: Financial parameters match check
      const amountMatches = parseFloat(capturedAmount) === parseFloat(order.amount_usd);
      const currencyMatches = capturedCurrency === order.currency;
      const customIdMatches = !order.custom_id || (customId === order.custom_id);

      if (!amountMatches || !currencyMatches || !customIdMatches) {
        // Quarantine invalid orphan to DLQ
        await this.quarantineToDLQ({
          event_id: event.event_id,
          transmission_id: event.transmission_id,
          failure_reason: "RECONCILIATION_FINANCIAL_MISMATCH",
          attempt_count: event.attempt_count + 1,
          last_error_redacted: `Amount/Currency/CustomID mismatch. Expected: $${order.amount_usd} ${order.currency}, Got: $${capturedAmount} ${capturedCurrency}`
        });
        await this.updateWebhookInboxStatus(event.transmission_id, "DEAD_LETTER");
        results.push({ transmission_id: event.transmission_id, status: "QUARANTINED_TO_DLQ" });
        continue;
      }

      // Reconciled successfully!
      await this.recordCaptureAtomic({
        capture_id: event.capture_id,
        order_id: order.order_id,
        amount_usd: parseFloat(capturedAmount),
        currency: capturedCurrency,
        status: "COMPLETED",
        captured_at: resource.create_time || new Date().toISOString()
      });

      // Issue single-use delivery authorization
      const authSessionId = `SESSION-${order.order_id}`;
      const tokenMsg = `${authSessionId}:${order.order_id}:${event.capture_id}:${capturedAmount}`;
      const deliveryToken = crypto.createHmac("sha256", "VELQIRIS_DIGITAL_DELIVERY_HMAC_SECRET_2026").update(tokenMsg).digest("hex");

      await this.issueDeliveryAuthorizationAtomic({
        token: deliveryToken,
        order_id: order.order_id,
        capture_id: event.capture_id,
        policy_audit_sha256: order.custom_id || "POL_HASH_ATTESTED",
        authorized_asset_title: "BTC/USDC Multi-Venue Autonomous Audit Report (Tier-1)"
      });

      // Enqueue Outbox notification
      await this.enqueueOutbox({
        aggregate_type: "ORDER",
        aggregate_id: order.order_id,
        event_type: "RECONCILIATION_SETTLED_DELIVERY_ISSUED",
        payload: { capture_id: event.capture_id, delivery_token: deliveryToken }
      });

      await this.updateWebhookInboxStatus(event.transmission_id, "PROCESSED");
      results.push({
        transmission_id: event.transmission_id,
        status: "RECONCILED_SUCCESS",
        delivery_token: deliveryToken
      });
    }

    return { reconciled: true, count: results.length, results };
  }

  async recordCaptureAtomic(capture) {
    if (this._tables.paypal_captures.has(capture.capture_id)) {
      return { is_duplicate: true, capture: this._tables.paypal_captures.get(capture.capture_id) };
    }
    const record = {
      ...capture,
      created_at: new Date().toISOString(),
      captured_at: capture.captured_at || new Date().toISOString()
    };
    this._tables.paypal_captures.set(capture.capture_id, record);

    const order = this._tables.paypal_orders.get(capture.order_id);
    if (order) {
      order.status = capture.status === "COMPLETED" ? "COMPLETED" : capture.status;
      order.updated_at = new Date().toISOString();
      order.version += 1;
    }
    this._recordAudit({
      entity_type: "CAPTURE",
      entity_id: capture.capture_id,
      action: `CAPTURE_${capture.status}`,
      actor: "PAYPAL_ENGINE",
      details: { order_id: capture.order_id, amount_usd: capture.amount_usd }
    });
    return { is_duplicate: false, capture: record };
  }

  async issueDeliveryAuthorizationAtomic(auth) {
    if (this._tables.delivery_authorizations.has(auth.token)) {
      throw new Error(`UNIQUE_CONSTRAINT_VIOLATION: delivery token already exists.`);
    }
    const record = {
      ...auth,
      is_consumed: false,
      consumed_at: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString()
    };
    this._tables.delivery_authorizations.set(auth.token, record);
    this._recordAudit({
      entity_type: "DELIVERY",
      entity_id: auth.token.slice(0, 16) + "...",
      action: "DELIVERY_TOKEN_ISSUED",
      actor: "DELIVERY_ENGINE",
      details: { order_id: auth.order_id, capture_id: auth.capture_id }
    });
    return record;
  }

  async getDeliveryAuthorizationByOrder(orderId) {
    for (const auth of this._tables.delivery_authorizations.values()) {
      if (auth.order_id === orderId) return auth;
    }
    return null;
  }

  async getDeliveryAuthorizationByCapture(captureId) {
    for (const auth of this._tables.delivery_authorizations.values()) {
      if (auth.capture_id === captureId) return auth;
    }
    return null;
  }

  async consumeDeliveryAuthorizationAtomic(token, clientIp = "127.0.0.1") {
    const auth = this._tables.delivery_authorizations.get(token);
    if (!auth) {
      return { success: false, error: "INVALID_DELIVERY_TOKEN", message: "Token not found." };
    }
    if (auth.is_consumed) {
      return { success: false, error: "TOKEN_ALREADY_CONSUMED", message: "Single-use digital deliverable was already retrieved." };
    }
    if (new Date(auth.expires_at) < new Date()) {
      return { success: false, error: "TOKEN_EXPIRED", message: "Delivery token has expired." };
    }

    auth.is_consumed = true;
    auth.consumed_at = new Date().toISOString();
    auth.consumed_by_ip = clientIp;

    const artifactText = `=== VELQIRIS AUTONOMOUS MARKET INTELLIGENCE REPORT ===\nAsset: ${auth.authorized_asset_title}\nSettlement: PayPal REST API v2 Verified\nOrder ID: ${auth.order_id}\nCapture ID: ${auth.capture_id}\nPolicy Audit SHA-256: ${auth.policy_audit_sha256}\nSingle-Use Delivery Token: ${token.slice(0, 16)}... [CONSUMED]\nStatus: CRYPTOGRAPHICALLY ATTESTED.`;
    const artifactDigest = crypto.createHash("sha256").update(artifactText).digest("hex");

    const artifact = {
      artifact_id: `ART-${auth.order_id}-${Date.now()}`,
      order_id: auth.order_id,
      capture_id: auth.capture_id,
      token,
      sha256_digest: artifactDigest,
      content_summary: artifactText,
      issued_at: new Date().toISOString()
    };
    this._tables.delivery_artifacts.set(artifact.artifact_id, artifact);

    this._recordAudit({
      entity_type: "DELIVERY",
      entity_id: token.slice(0, 16) + "...",
      action: "DELIVERY_TOKEN_CONSUMED",
      actor: "BUYER",
      details: { artifact_id: artifact.artifact_id, sha256: artifactDigest }
    });

    return {
      success: true,
      status: "DELIVERED_SUCCESS",
      artifact,
      sha256_digest: artifactDigest,
      report_text: artifactText
    };
  }

  _recordAudit(entry) {
    this._tables.audit_events.push({
      event_id: this._tables.audit_events.length + 1,
      ...entry,
      created_at: new Date().toISOString()
    });
  }

  getAuditLog(entityId = null) {
    if (!entityId) return [...this._tables.audit_events];
    return this._tables.audit_events.filter(e => e.entity_id === entityId);
  }

  resetForTesting() {
    this._tables.purchase_intents.clear();
    this._tables.paypal_orders.clear();
    this._tables.paypal_captures.clear();
    this._tables.webhook_events.clear();
    this._tables.webhook_inbox.clear();
    this._tables.transactional_outbox = [];
    this._tables.dead_letter_queue = [];
    this._tables.idempotency_keys.clear();
    this._tables.delivery_authorizations.clear();
    this._tables.delivery_artifacts.clear();
    this._tables.audit_events = [];
    this._outboxSeq = 1;
    this._dlqSeq = 1;
    this._initDefaultMandate();
  }
}

// ==============================================================================
// 2. POSTGRES STORAGE ADAPTER (Production Transactional PostgreSQL Engine)
// ==============================================================================
class PostgresStorageAdapter {
  constructor(config = {}) {
    if (!pg) {
      throw new Error("DEPENDENCY_ERROR: 'pg' package is not installed.");
    }
    const connectionString = config.connectionString || process.env.DATABASE_URL || "postgresql://velqiris_admin:velqiris_test_password_2026@127.0.0.1:5432/velqiris_test_db";
    this.pool = new pg.Pool({
      connectionString,
      max: config.max || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
  }

  async close() {
    await this.pool.end();
  }

  /**
   * Helper: Runs callback within a single checked-out client with BEGIN/COMMIT/ROLLBACK.
   */
  async withTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getMandate(mandateId) {
    const res = await this.pool.query(
      "SELECT * FROM procurement_mandates WHERE mandate_id = $1",
      [mandateId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      mandate_id: row.mandate_id,
      title: row.title,
      max_budget_usd: parseFloat(row.max_budget_usd),
      currency: row.currency,
      max_tolerable_risk_score: parseFloat(row.max_tolerable_risk_score),
      authorized_merchants: row.authorized_merchants,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version
    };
  }

  async recordMandate(mandate) {
    const res = await this.pool.query(
      `INSERT INTO procurement_mandates 
       (mandate_id, title, max_budget_usd, currency, max_tolerable_risk_score, authorized_merchants, is_active, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (mandate_id) DO UPDATE 
       SET title = EXCLUDED.title,
           max_budget_usd = EXCLUDED.max_budget_usd,
           updated_at = NOW()
       RETURNING *`,
      [
        mandate.mandate_id,
        mandate.title,
        mandate.max_budget_usd,
        mandate.currency || "USD",
        mandate.max_tolerable_risk_score,
        JSON.stringify(mandate.authorized_merchants),
        mandate.is_active !== false
      ]
    );
    return res.rows[0];
  }

  async createPurchaseIntent(intent) {
    return this.withTransaction(async (client) => {
      const res = await client.query(
        `INSERT INTO purchase_intents 
         (intent_id, mandate_id, recommended_offer_id, vendor_name, merchant_id, proposed_price_usd,
          quality_score, risk_score, uncertainty_score, confidence_score, utility_score,
          decision_rationale, engine_mode, injection_detected, policy_approved, policy_verdict_code, policy_audit_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          intent.intent_id,
          intent.mandate_id,
          intent.recommended_offer_id,
          intent.vendor_name,
          intent.merchant_id,
          intent.proposed_price_usd,
          intent.quality_score,
          intent.risk_score,
          intent.uncertainty_score,
          intent.confidence_score,
          intent.utility_score,
          intent.decision_rationale,
          intent.engine_mode,
          intent.injection_detected || false,
          intent.policy_approved,
          intent.policy_verdict_code,
          intent.policy_audit_sha256
        ]
      );

      await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, details)
         VALUES ('PURCHASE_INTENT', $1, 'INTENT_CREATED', 'POLICY_GATE', $2)`,
        [intent.intent_id, JSON.stringify({ verdict: intent.policy_verdict_code, approved: intent.policy_approved })]
      );

      return res.rows[0];
    });
  }

  async createPayPalOrder(order, idempotencyKey) {
    return this.withTransaction(async (client) => {
      if (idempotencyKey) {
        const idempRes = await client.query(
          "SELECT response_payload FROM idempotency_keys WHERE request_key = $1",
          [idempotencyKey]
        );
        if (idempRes.rows.length > 0) {
          return { is_duplicate: true, existing: idempRes.rows[0].response_payload };
        }
      }

      const res = await client.query(
        `INSERT INTO paypal_orders 
         (order_id, intent_id, mandate_id, merchant_id, amount_usd, currency, custom_id, status, is_sandbox, raw_order_spec)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          order.order_id,
          order.intent_id,
          order.mandate_id,
          order.merchant_id,
          order.amount_usd,
          order.currency || "USD",
          order.custom_id,
          order.status || "CREATED",
          order.is_sandbox !== false,
          JSON.stringify(order.raw_order_spec || {})
        ]
      );

      const record = res.rows[0];

      if (idempotencyKey) {
        await client.query(
          `INSERT INTO idempotency_keys (request_key, scope, resource_id, response_payload, expires_at)
           VALUES ($1, 'CREATE_ORDER', $2, $3, NOW() + INTERVAL '1 day')`,
          [idempotencyKey, order.order_id, JSON.stringify(record)]
        );
      }

      await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, details)
         VALUES ('ORDER', $1, 'ORDER_CREATED', 'PAYPAL_PROCESSOR', $2)`,
        [order.order_id, JSON.stringify({ amount_usd: order.amount_usd, custom_id: order.custom_id })]
      );

      return { is_duplicate: false, order: record };
    });
  }

  async getPayPalOrder(orderId) {
    const res = await this.pool.query(
      "SELECT * FROM paypal_orders WHERE order_id = $1",
      [orderId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      order_id: row.order_id,
      intent_id: row.intent_id,
      mandate_id: row.mandate_id,
      merchant_id: row.merchant_id,
      amount_usd: parseFloat(row.amount_usd),
      currency: row.currency,
      custom_id: row.custom_id,
      status: row.status,
      version: row.version
    };
  }

  async recordWebhookEvent(event) {
    return this.withTransaction(async (client) => {
      // Check existing
      const checkRes = await client.query(
        "SELECT transmission_id FROM webhook_events WHERE transmission_id = $1",
        [event.transmission_id]
      );
      if (checkRes.rows.length > 0) {
        return { is_duplicate: true, status: "REPLAY_REJECTED" };
      }

      const res = await client.query(
        `INSERT INTO webhook_events 
         (transmission_id, event_id, event_type, resource_id, verification_status, verification_method, payload_sha256, raw_payload, processed_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PROCESSED')
         RETURNING *`,
        [
          event.transmission_id,
          event.event_id,
          event.event_type,
          event.resource_id,
          event.verification_status,
          event.verification_method,
          event.payload_sha256,
          JSON.stringify(event.raw_payload || {})
        ]
      );

      await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, details)
         VALUES ('WEBHOOK', $1, 'WEBHOOK_VERIFIED_AND_RECORDED', 'PAYPAL_WEBHOOK', $2)`,
        [event.transmission_id, JSON.stringify({ event_type: event.event_type, resource_id: event.resource_id })]
      );

      return { is_duplicate: false, event: res.rows[0] };
    });
  }

  async isWebhookDuplicate(transmissionId) {
    const res = await this.pool.query(
      "SELECT transmission_id FROM webhook_events WHERE transmission_id = $1 UNION SELECT transmission_id FROM webhook_inbox WHERE transmission_id = $1",
      [transmissionId]
    );
    return res.rows.length > 0;
  }

  // --- GATE V: Durable Webhook Inbox ---
  async recordWebhookInbox(inboxEntry) {
    return this.withTransaction(async (client) => {
      const check = await client.query(
        "SELECT * FROM webhook_inbox WHERE transmission_id = $1",
        [inboxEntry.transmission_id]
      );
      if (check.rows.length > 0) {
        return { is_duplicate: true, existing: check.rows[0] };
      }

      const res = await client.query(
        `INSERT INTO webhook_inbox 
         (transmission_id, event_id, event_type, order_id, capture_id, verification_status, verification_method, processing_status, attempt_count, payload_sha256, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          inboxEntry.transmission_id,
          inboxEntry.event_id,
          inboxEntry.event_type,
          inboxEntry.order_id || null,
          inboxEntry.capture_id || null,
          inboxEntry.verification_status,
          inboxEntry.verification_method,
          inboxEntry.processing_status || "RECEIVED",
          inboxEntry.attempt_count || 0,
          inboxEntry.payload_sha256,
          JSON.stringify(inboxEntry.raw_payload || {})
        ]
      );

      await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, details)
         VALUES ('WEBHOOK_INBOX', $1, $2, 'PAYPAL_INGRESS', $3)`,
        [inboxEntry.transmission_id, `INBOX_RECORDED_${inboxEntry.processing_status || 'RECEIVED'}`, JSON.stringify({ event_id: inboxEntry.event_id })]
      );

      return { is_duplicate: false, record: res.rows[0] };
    });
  }

  async getWebhookInbox(transmissionId) {
    const res = await this.pool.query(
      "SELECT * FROM webhook_inbox WHERE transmission_id = $1",
      [transmissionId]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  async updateWebhookInboxStatus(transmissionId, status) {
    const res = await this.pool.query(
      "UPDATE webhook_inbox SET processing_status = $1, attempt_count = attempt_count + 1, updated_at = NOW() WHERE transmission_id = $2 RETURNING *",
      [status, transmissionId]
    );
    return res.rows.length > 0;
  }

  // --- GATE V: Transactional Outbox ---
  async enqueueOutbox(action, externalClient = null) {
    const runner = externalClient || this.pool;
    const res = await runner.query(
      `INSERT INTO transactional_outbox 
       (aggregate_type, aggregate_id, event_type, payload, status, retry_count, max_retries, next_retry_at)
       VALUES ($1, $2, $3, $4, 'PENDING', 0, $5, NOW())
       RETURNING *`,
      [
        action.aggregate_type,
        action.aggregate_id,
        action.event_type,
        JSON.stringify(action.payload || {}),
        action.max_retries || 5
      ]
    );
    return res.rows[0];
  }

  async leaseOutboxBatch(batchSize = 10, leaseDurationMs = 30000) {
    const leaseToken = crypto.randomBytes(16).toString("hex");
    return this.withTransaction(async (client) => {
      const res = await client.query(
        `WITH available AS (
           SELECT id FROM transactional_outbox
           WHERE status = 'PENDING' OR (status = 'PROCESSING' AND lease_expires_at < NOW())
           ORDER BY id ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE transactional_outbox
         SET status = 'PROCESSING',
             lease_token = $2,
             lease_expires_at = NOW() + ($3 || ' milliseconds')::interval,
             retry_count = retry_count + 1
         FROM available
         WHERE transactional_outbox.id = available.id
         RETURNING transactional_outbox.*`,
        [batchSize, leaseToken, leaseDurationMs]
      );
      return { leaseToken, items: res.rows };
    });
  }

  async completeOutboxItem(id, leaseToken) {
    const res = await this.pool.query(
      `UPDATE transactional_outbox 
       SET status = 'COMPLETED', processed_at = NOW(), lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND (lease_token = $2 OR lease_token IS NULL)
       RETURNING *`,
      [id, leaseToken]
    );
    return res.rows.length > 0;
  }

  async failOutboxItem(id, leaseToken, errorMsg) {
    return this.withTransaction(async (client) => {
      const itemRes = await client.query("SELECT * FROM transactional_outbox WHERE id = $1", [id]);
      if (itemRes.rows.length === 0) return false;
      const item = itemRes.rows[0];

      if (item.retry_count >= item.max_retries) {
        await client.query(
          "UPDATE transactional_outbox SET status = 'FAILED', lease_token = NULL, lease_expires_at = NULL WHERE id = $1",
          [id]
        );
        // Route to DLQ
        await client.query(
          `INSERT INTO dead_letter_queue (event_id, transmission_id, failure_reason, attempt_count, last_error_redacted)
           VALUES ($1, $2, $3, $4, $5)`,
          [`OUTBOX-${id}`, `AGG-${item.aggregate_id}`, `MAX_RETRIES_EXCEEDED: ${errorMsg}`, item.retry_count, errorMsg]
        );
      } else {
        await client.query(
          `UPDATE transactional_outbox 
           SET status = 'PENDING', next_retry_at = NOW() + ($2 || ' seconds')::interval, lease_token = NULL, lease_expires_at = NULL
           WHERE id = $1`,
          [id, item.retry_count * 5]
        );
      }
      return true;
    });
  }

  // --- GATE V: Dead Letter Queue (DLQ) ---
  async quarantineToDLQ(entry) {
    const res = await this.pool.query(
      `INSERT INTO dead_letter_queue 
       (event_id, transmission_id, failure_reason, attempt_count, last_error_redacted)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        entry.event_id,
        entry.transmission_id,
        entry.failure_reason,
        entry.attempt_count || 1,
        entry.last_error_redacted || "Redacted trace"
      ]
    );

    await this.pool.query(
      `INSERT INTO audit_events (entity_type, entity_id, action, actor, details)
       VALUES ('DLQ', $1, 'QUARANTINED_TO_DLQ', 'RECOVERY_WORKER', $2)`,
      [entry.transmission_id, JSON.stringify({ reason: entry.failure_reason })]
    );

    return res.rows[0];
  }

  async getDLQItems() {
    const res = await this.pool.query("SELECT * FROM dead_letter_queue ORDER BY id DESC");
    return res.rows;
  }

  // --- GATE W: Orphan Webhook Reconciliation ---
  async reconcileOrphanWebhooks(orderId) {
    const order = await this.getPayPalOrder(orderId);
    if (!order) return { reconciled: false, reason: "ORDER_NOT_FOUND" };

    return this.withTransaction(async (client) => {
      // Find pending inbox events for this order with row-level locks
      const inboxRes = await client.query(
        `SELECT * FROM webhook_inbox 
         WHERE (order_id = $1 OR raw_payload->'resource'->'supplementary_data'->'related_ids'->>'order_id' = $1)
           AND processing_status = 'PENDING_RECONCILIATION'
         FOR UPDATE`,
        [orderId]
      );

      if (inboxRes.rows.length === 0) {
        return { reconciled: false, count: 0, reason: "NO_PENDING_ORPHAN_EVENTS" };
      }

      const results = [];
      for (const event of inboxRes.rows) {
        const resource = event.raw_payload?.resource || {};
        const capturedAmount = resource.amount?.value;
        const capturedCurrency = resource.amount?.currency_code;
        const customId = resource.custom_id;

        const amountMatches = parseFloat(capturedAmount) === parseFloat(order.amount_usd);
        const currencyMatches = capturedCurrency === order.currency;
        const customIdMatches = !order.custom_id || (customId === order.custom_id);

        if (!amountMatches || !currencyMatches || !customIdMatches) {
          // Quarantine mismatch to DLQ
          await client.query(
            `INSERT INTO dead_letter_queue (event_id, transmission_id, failure_reason, attempt_count, last_error_redacted)
             VALUES ($1, $2, 'RECONCILIATION_FINANCIAL_MISMATCH', $3, $4)`,
            [
              event.event_id,
              event.transmission_id,
              event.attempt_count + 1,
              `Mismatch. Expected $${order.amount_usd} ${order.currency}, Got $${capturedAmount} ${capturedCurrency}`
            ]
          );
          await client.query(
            "UPDATE webhook_inbox SET processing_status = 'DEAD_LETTER', updated_at = NOW() WHERE transmission_id = $1",
            [event.transmission_id]
          );
          results.push({ transmission_id: event.transmission_id, status: "QUARANTINED_TO_DLQ" });
          continue;
        }

        // Record capture atomically
        await client.query(
          `INSERT INTO paypal_captures (capture_id, order_id, amount_usd, currency, status, captured_at)
           VALUES ($1, $2, $3, $4, 'COMPLETED', NOW())
           ON CONFLICT (capture_id) DO NOTHING`,
          [event.capture_id, order.order_id, parseFloat(capturedAmount), capturedCurrency]
        );

        // Update order status
        await client.query(
          "UPDATE paypal_orders SET status = 'COMPLETED', updated_at = NOW(), version = version + 1 WHERE order_id = $1",
          [order.order_id]
        );

        // Issue delivery authorization
        const authSessionId = `SESSION-${order.order_id}`;
        const tokenMsg = `${authSessionId}:${order.order_id}:${event.capture_id}:${capturedAmount}`;
        const deliveryToken = crypto.createHmac("sha256", "VELQIRIS_DIGITAL_DELIVERY_HMAC_SECRET_2026").update(tokenMsg).digest("hex");

        await client.query(
          `INSERT INTO delivery_authorizations 
           (token, order_id, capture_id, policy_audit_sha256, authorized_asset_title, expires_at)
           VALUES ($1, $2, $3, $4, 'BTC/USDC Multi-Venue Autonomous Audit Report (Tier-1)', NOW() + INTERVAL '1 hour')
           ON CONFLICT (token) DO NOTHING`,
          [deliveryToken, order.order_id, event.capture_id, order.custom_id || "POL_HASH_ATTESTED"]
        );

        // Enqueue Outbox notification
        await client.query(
          `INSERT INTO transactional_outbox (aggregate_type, aggregate_id, event_type, payload, status)
           VALUES ('ORDER', $1, 'RECONCILIATION_SETTLED_DELIVERY_ISSUED', $2, 'PENDING')`,
          [order.order_id, JSON.stringify({ capture_id: event.capture_id, delivery_token: deliveryToken })]
        );

        // Mark inbox item PROCESSED
        await client.query(
          "UPDATE webhook_inbox SET processing_status = 'PROCESSED', updated_at = NOW() WHERE transmission_id = $1",
          [event.transmission_id]
        );

        results.push({
          transmission_id: event.transmission_id,
          status: "RECONCILED_SUCCESS",
          delivery_token: deliveryToken
        });
      }

      return { reconciled: true, count: results.length, results };
    });
  }

  async recordCaptureAtomic(capture) {
    return this.withTransaction(async (client) => {
      const check = await client.query("SELECT * FROM paypal_captures WHERE capture_id = $1", [capture.capture_id]);
      if (check.rows.length > 0) {
        return { is_duplicate: true, capture: check.rows[0] };
      }

      const res = await client.query(
        `INSERT INTO paypal_captures (capture_id, order_id, amount_usd, currency, status, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          capture.capture_id,
          capture.order_id,
          capture.amount_usd,
          capture.currency || "USD",
          capture.status,
          capture.captured_at || new Date().toISOString()
        ]
      );

      if (capture.status === "COMPLETED") {
        await client.query(
          "UPDATE paypal_orders SET status = 'COMPLETED', updated_at = NOW(), version = version + 1 WHERE order_id = $1",
          [capture.order_id]
        );
      }

      await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, details)
         VALUES ('CAPTURE', $1, $2, 'PAYPAL_ENGINE', $3)`,
        [capture.capture_id, `CAPTURE_${capture.status}`, JSON.stringify({ order_id: capture.order_id, amount: capture.amount_usd })]
      );

      return { is_duplicate: false, capture: res.rows[0] };
    });
  }

  async issueDeliveryAuthorizationAtomic(auth) {
    return this.withTransaction(async (client) => {
      const check = await client.query("SELECT token FROM delivery_authorizations WHERE token = $1", [auth.token]);
      if (check.rows.length > 0) {
        throw new Error("UNIQUE_CONSTRAINT_VIOLATION: delivery token already exists.");
      }

      const res = await client.query(
        `INSERT INTO delivery_authorizations 
         (token, order_id, capture_id, policy_audit_sha256, authorized_asset_title, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour')
         RETURNING *`,
        [auth.token, auth.order_id, auth.capture_id, auth.policy_audit_sha256, auth.authorized_asset_title]
      );

      await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, details)
         VALUES ('DELIVERY', $1, 'DELIVERY_TOKEN_ISSUED', 'DELIVERY_ENGINE', $2)`,
        [auth.token.slice(0, 16) + "...", JSON.stringify({ order_id: auth.order_id, capture_id: auth.capture_id })]
      );

      return res.rows[0];
    });
  }

  async getDeliveryAuthorizationByOrder(orderId) {
    const res = await this.pool.query(
      "SELECT * FROM delivery_authorizations WHERE order_id = $1 LIMIT 1",
      [orderId]
    );
    return res.rows[0] || null;
  }

  async getDeliveryAuthorizationByCapture(captureId) {
    const res = await this.pool.query(
      "SELECT * FROM delivery_authorizations WHERE capture_id = $1 LIMIT 1",
      [captureId]
    );
    return res.rows[0] || null;
  }

  async consumeDeliveryAuthorizationAtomic(token, clientIp = "127.0.0.1") {
    return this.withTransaction(async (client) => {
      // Row lock on delivery authorization
      const res = await client.query(
        "SELECT * FROM delivery_authorizations WHERE token = $1 FOR UPDATE",
        [token]
      );

      if (res.rows.length === 0) {
        return { success: false, error: "INVALID_DELIVERY_TOKEN", message: "Token not found." };
      }

      const auth = res.rows[0];
      if (auth.is_consumed) {
        return { success: false, error: "TOKEN_ALREADY_CONSUMED", message: "Single-use deliverable already retrieved." };
      }

      if (new Date(auth.expires_at) < new Date()) {
        return { success: false, error: "TOKEN_EXPIRED", message: "Delivery token has expired." };
      }

      // Mark consumed atomically
      await client.query(
        "UPDATE delivery_authorizations SET is_consumed = TRUE, consumed_at = NOW(), consumed_by_ip = $1 WHERE token = $2",
        [clientIp, token]
      );

      // Create artifact
      const artifactText = `=== VELQIRIS AUTONOMOUS MARKET INTELLIGENCE REPORT ===\nAsset: ${auth.authorized_asset_title}\nSettlement: PayPal REST API v2 Verified\nOrder ID: ${auth.order_id}\nCapture ID: ${auth.capture_id}\nPolicy Audit SHA-256: ${auth.policy_audit_sha256}\nSingle-Use Delivery Token: ${token.slice(0, 16)}... [CONSUMED]\nStatus: CRYPTOGRAPHICALLY ATTESTED.`;
      const artifactDigest = crypto.createHash("sha256").update(artifactText).digest("hex");
      const artifactId = `ART-${auth.order_id}-${Date.now()}`;

      await client.query(
        `INSERT INTO delivery_artifacts (artifact_id, order_id, capture_id, token, sha256_digest, content_summary)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [artifactId, auth.order_id, auth.capture_id, token, artifactDigest, artifactText]
      );

      await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, details)
         VALUES ('DELIVERY', $1, 'DELIVERY_TOKEN_CONSUMED', 'BUYER', $2)`,
        [token.slice(0, 16) + "...", JSON.stringify({ artifact_id: artifactId, sha256: artifactDigest })]
      );

      return {
        success: true,
        status: "DELIVERED_SUCCESS",
        artifact: { artifact_id: artifactId, order_id: auth.order_id, capture_id: auth.capture_id },
        sha256_digest: artifactDigest,
        report_text: artifactText
      };
    });
  }

  async getAuditLog(entityId = null) {
    if (entityId) {
      const res = await this.pool.query("SELECT * FROM audit_events WHERE entity_id = $1 ORDER BY event_id ASC", [entityId]);
      return res.rows;
    }
    const res = await this.pool.query("SELECT * FROM audit_events ORDER BY event_id ASC");
    return res.rows;
  }
}

// Default singleton instance
const storageInstance = new MemoryStorageAdapter();

function getStorageAdapter(options = {}) {
  const dbUrl = options.databaseUrl || process.env.DATABASE_URL;
  if (dbUrl && pg) {
    return new PostgresStorageAdapter({ connectionString: dbUrl });
  }
  return new MemoryStorageAdapter();
}

module.exports = {
  STORAGE_HOSTED_STATUS,
  MemoryStorageAdapter,
  PostgresStorageAdapter,
  getStorageAdapter,
  storage: storageInstance
};
