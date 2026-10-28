-- ==============================================================================
-- VELQIRIS AGENTIC COMMERCE TRUST GATE — CANONICAL POSTGRESQL SCHEMA
-- Single Source of Truth for Institutional AI Procurement & PayPal Settlement
-- ==============================================================================

-- Enable UUID extension if supported
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. PROCUREMENT MANDATES (Institutional Spending Boundaries)
CREATE TABLE IF NOT EXISTS procurement_mandates (
    mandate_id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    max_budget_usd NUMERIC(10, 2) NOT NULL CHECK (max_budget_usd > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    max_tolerable_risk_score NUMERIC(5, 2) NOT NULL CHECK (max_tolerable_risk_score >= 0 AND max_tolerable_risk_score <= 100),
    authorized_merchants JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INT NOT NULL DEFAULT 1
);

-- 2. PURCHASE INTENTS (AI Decision Records & Proposed Orders)
CREATE TABLE IF NOT EXISTS purchase_intents (
    intent_id VARCHAR(64) PRIMARY KEY,
    mandate_id VARCHAR(64) NOT NULL REFERENCES procurement_mandates(mandate_id),
    recommended_offer_id VARCHAR(64) NOT NULL,
    vendor_name VARCHAR(255) NOT NULL,
    merchant_id VARCHAR(64) NOT NULL,
    proposed_price_usd NUMERIC(10, 2) NOT NULL,
    quality_score NUMERIC(5, 2) NOT NULL,
    risk_score NUMERIC(5, 2) NOT NULL,
    uncertainty_score NUMERIC(5, 4) NOT NULL,
    confidence_score NUMERIC(5, 4) NOT NULL,
    utility_score NUMERIC(8, 4) NOT NULL,
    decision_rationale TEXT NOT NULL,
    engine_mode VARCHAR(32) NOT NULL, -- 'ONLINE_LLM_INFERENCE' or 'DEMO_DETERMINISTIC_ONLY'
    injection_detected BOOLEAN NOT NULL DEFAULT FALSE,
    policy_approved BOOLEAN NOT NULL DEFAULT FALSE,
    policy_verdict_code VARCHAR(64) NOT NULL,
    policy_audit_sha256 VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. PAYPAL ORDERS (Locked Order Specifications Dispatched to PayPal REST v2)
CREATE TABLE IF NOT EXISTS paypal_orders (
    order_id VARCHAR(64) PRIMARY KEY, -- PayPal v2 Order ID (e.g., 4GM55617DD508394F)
    intent_id VARCHAR(64) NOT NULL REFERENCES purchase_intents(intent_id),
    mandate_id VARCHAR(64) NOT NULL REFERENCES procurement_mandates(mandate_id),
    merchant_id VARCHAR(64) NOT NULL,
    amount_usd NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    custom_id VARCHAR(64) NOT NULL, -- GATE_AUTH_<policy_hash_prefix>
    status VARCHAR(32) NOT NULL, -- 'CREATED', 'SAVED', 'APPROVED', 'VOIDED', 'COMPLETED'
    is_sandbox BOOLEAN NOT NULL DEFAULT TRUE,
    raw_order_spec JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INT NOT NULL DEFAULT 1
);

-- 4. PAYPAL CAPTURES (Settlement Confirmations from PayPal Engine)
CREATE TABLE IF NOT EXISTS paypal_captures (
    capture_id VARCHAR(64) PRIMARY KEY, -- PayPal Capture ID
    order_id VARCHAR(64) NOT NULL REFERENCES paypal_orders(order_id),
    amount_usd NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status VARCHAR(32) NOT NULL, -- 'PENDING', 'COMPLETED', 'FAILED', 'DENIED', 'REVERSED'
    seller_receivable_breakdown JSONB,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. WEBHOOK EVENTS (Audit Trail of Official PayPal Webhook Dispatches)
CREATE TABLE IF NOT EXISTS webhook_events (
    transmission_id VARCHAR(128) PRIMARY KEY, -- PAYPAL-TRANSMISSION-ID header (unique deduplication)
    event_id VARCHAR(64) NOT NULL, -- PayPal internal event ID
    event_type VARCHAR(64) NOT NULL, -- e.g., 'PAYMENT.CAPTURE.COMPLETED'
    resource_id VARCHAR(64) NOT NULL, -- capture_id or order_id
    verification_status VARCHAR(32) NOT NULL, -- 'SUCCESS', 'FAILURE', 'UNVERIFIED'
    verification_method VARCHAR(32) NOT NULL, -- 'PAYPAL_API_VERIFY' or 'LOCAL_RSA_VERIFY'
    payload_sha256 VARCHAR(64) NOT NULL,
    raw_payload JSONB NOT NULL,
    processed_status VARCHAR(32) NOT NULL DEFAULT 'PROCESSED', -- 'PROCESSED', 'REPLAY_REJECTED', 'IGNORED'
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_resource ON webhook_events(resource_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events(event_type);

-- 6. IDEMPOTENCY KEYS (Distributed Replay Attack Defense)
CREATE TABLE IF NOT EXISTS idempotency_keys (
    request_key VARCHAR(128) PRIMARY KEY, -- Unique client/engine request identifier
    scope VARCHAR(32) NOT NULL, -- 'CREATE_ORDER', 'CAPTURE_ORDER', 'WEBHOOK_DELIVERY'
    resource_id VARCHAR(64) NOT NULL,
    response_payload JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. DELIVERY AUTHORIZATIONS (Post-Settlement Access Tickets)
CREATE TABLE IF NOT EXISTS delivery_authorizations (
    token VARCHAR(64) PRIMARY KEY, -- HMAC-SHA256 Single-Use Delivery Token
    order_id VARCHAR(64) NOT NULL REFERENCES paypal_orders(order_id),
    capture_id VARCHAR(64) NOT NULL REFERENCES paypal_captures(capture_id),
    policy_audit_sha256 VARCHAR(64) NOT NULL,
    authorized_asset_title VARCHAR(255) NOT NULL,
    is_consumed BOOLEAN NOT NULL DEFAULT FALSE,
    consumed_at TIMESTAMPTZ,
    consumed_by_ip VARCHAR(64),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. DELIVERY ARTIFACTS (Cryptographically Attested Deliverables)
CREATE TABLE IF NOT EXISTS delivery_artifacts (
    artifact_id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES paypal_orders(order_id),
    capture_id VARCHAR(64) NOT NULL REFERENCES paypal_captures(capture_id),
    token VARCHAR(64) NOT NULL REFERENCES delivery_authorizations(token),
    sha256_digest VARCHAR(64) NOT NULL UNIQUE,
    content_summary TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. AUDIT EVENTS (Append-Only Non-Repudiation Ledger)
CREATE TABLE IF NOT EXISTS audit_events (
    event_id SERIAL PRIMARY KEY,
    entity_type VARCHAR(32) NOT NULL, -- 'MANDATE', 'ORDER', 'CAPTURE', 'WEBHOOK', 'DELIVERY'
    entity_id VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    prev_state VARCHAR(32),
    new_state VARCHAR(32),
    actor VARCHAR(64) NOT NULL, -- 'AI_AGENT', 'POLICY_GATE', 'PAYPAL_WEBHOOK', 'BUYER'
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);

-- 10. DURABLE WEBHOOK INBOX (Gate V: Asynchronous Replay & Reconciliation Ingress)
CREATE TABLE IF NOT EXISTS webhook_inbox (
    transmission_id VARCHAR(128) PRIMARY KEY, -- PayPal transmission ID (primary deduplication key)
    event_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    order_id VARCHAR(64),
    capture_id VARCHAR(64),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verification_status VARCHAR(32) NOT NULL, -- 'SUCCESS', 'FAILURE', 'TEST_HARNESS_MOCK'
    verification_method VARCHAR(32) NOT NULL, -- 'PAYPAL_API_VERIFY', 'TEST_HARNESS_MOCK'
    processing_status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED', -- 'RECEIVED', 'PENDING_RECONCILIATION', 'PROCESSED', 'FAILED', 'DEAD_LETTER'
    attempt_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    payload_sha256 VARCHAR(64) NOT NULL,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON webhook_inbox(processing_status);
CREATE INDEX IF NOT EXISTS idx_inbox_order ON webhook_inbox(order_id);
CREATE INDEX IF NOT EXISTS idx_inbox_capture ON webhook_inbox(capture_id);

-- 11. TRANSACTIONAL OUTBOX (Gate V: Post-Commit Guaranteed Operations)
CREATE TABLE IF NOT EXISTS transactional_outbox (
    id SERIAL PRIMARY KEY,
    aggregate_type VARCHAR(64) NOT NULL, -- 'ORDER', 'CAPTURE', 'WEBHOOK', 'DELIVERY'
    aggregate_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL, -- 'ISSUE_DELIVERY_TOKEN', 'NOTIFY_RECONCILIATION', 'RECORD_CAPTURE'
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_token VARCHAR(64), -- Transactional lease for concurrent worker safety
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_queue ON transactional_outbox(status, next_retry_at);

-- 12. DEAD LETTER QUEUE (Gate V: Quarantined Unprocessable Webhooks & Operations)
CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL,
    transmission_id VARCHAR(128) NOT NULL,
    failure_reason VARCHAR(128) NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    last_error_redacted TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    review_status VARCHAR(32) NOT NULL DEFAULT 'UNREVIEWED' -- 'UNREVIEWED', 'ACKNOWLEDGED', 'RESOLVED'
);
CREATE INDEX IF NOT EXISTS idx_dlq_transmission ON dead_letter_queue(transmission_id);
CREATE INDEX IF NOT EXISTS idx_dlq_status ON dead_letter_queue(review_status);

