/**
 * VELQIRIS — OFFICIAL PAYPAL WEBHOOK CRYPTOGRAPHIC VERIFICATION & RECONCILIATION
 * Endpoint: /.netlify/functions/paypal-webhook
 * 
 * Strict Security Invariants (P0 Audit Acceptance):
 * 1. PayPal REST v2 Webhook Verification (POST /v1/notifications/verify-webhook-signature)
 *    Enforced strictly BEFORE any storage idempotency check or state transition.
 * 2. Strict SSRF defense on certificate URLs (official PayPal domains only).
 * 3. Zero hardcoded/fallback delivery secrets: server secret must be explicitly configured.
 * 4. Zero demo order fallbacks: financial identifiers must correlate to an authentic authorized order.
 * 5. Complete mandate and policy hash binding required before single-use deliverable release.
 * 6. Isolated test harness via createWebhookHandler dependency injection (zero global test verifiers).
 */

const crypto = require("crypto");
const { storage } = require("./storage-adapter");

const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
const DEFAULT_WEBHOOK_ID = "4HN53346UF6053313";

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    },
    body: JSON.stringify(body)
  };
}

// Compute CRC32 for raw body
function computeCrc32(str) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < str.length; i++) {
    const byte = str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      const bit = (crc ^ byte) & 1;
      crc = (crc >>> 1) ^ (bit ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ (-1)) >>> 0;
}

// SSRF Defense: only allow official PayPal domains for cert URL
function isValidPayPalCertUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "api.sandbox.paypal.com" ||
      hostname === "api-m.sandbox.paypal.com" ||
      hostname === "api.paypal.com" ||
      hostname === "api-m.paypal.com"
    );
  } catch {
    return false;
  }
}

async function verifyWithPayPalApi(headers, rawBody, webhookId) {
  const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, reason: "CREDENTIALS_MISSING" };

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenResp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      return { ok: false, reason: "OAUTH_FAILED" };
    }

    const verifyResp = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenData.access_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"] || headers["PAYPAL-AUTH-ALGO"],
        cert_url: headers["paypal-cert-url"] || headers["PAYPAL-CERT-URL"],
        transmission_id: headers["paypal-transmission-id"] || headers["PAYPAL-TRANSMISSION-ID"],
        transmission_sig: headers["paypal-transmission-sig"] || headers["PAYPAL-TRANSMISSION-SIG"],
        transmission_time: headers["paypal-transmission-time"] || headers["PAYPAL-TRANSMISSION-TIME"],
        webhook_id: webhookId,
        webhook_event: JSON.parse(rawBody)
      })
    });
    const verifyData = await verifyResp.json();
    if (verifyResp.ok && verifyData.verification_status === "SUCCESS") {
      return { ok: true, method: "PAYPAL_API_VERIFY" };
    }
    return { ok: false, reason: `VERIFICATION_STATUS_${verifyData.verification_status || "UNKNOWN"}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Factory creating the webhook handler with isolated dependency injection for testing.
 * Public export exports.handler is created with zero options, enforcing real PayPal verification.
 */
function createWebhookHandler(options = {}) {
  const customVerifier = options.verifier || null;
  const store = options.storage || storage;
  const tokenSecret = options.tokenSecret !== undefined ? options.tokenSecret : process.env.VELQIRIS_DELIVERY_SECRET;

  return async function handler(event) {
    if (event.httpMethod === "GET") {
      return reply(200, {
        system: "VELQIRIS PayPal Webhook Ingress Gate",
        status: "ONLINE",
        registered_webhook_id: process.env.PAYPAL_SANDBOX_WEBHOOK_ID ? "CONFIGURED_IN_ENV" : DEFAULT_WEBHOOK_ID
      });
    }

    if (event.httpMethod !== "POST") {
      return reply(405, { error: "METHOD_NOT_ALLOWED" });
    }

    const headers = event.headers || {};
    const transmissionId = headers["paypal-transmission-id"] || headers["PAYPAL-TRANSMISSION-ID"];
    const transmissionTime = headers["paypal-transmission-time"] || headers["PAYPAL-TRANSMISSION-TIME"];
    const transmissionSig = headers["paypal-transmission-sig"] || headers["PAYPAL-TRANSMISSION-SIG"];
    const certUrl = headers["paypal-cert-url"] || headers["PAYPAL-CERT-URL"];

    if (!transmissionId || !transmissionTime) {
      return reply(400, { error: "MISSING_MANDATORY_PAYPAL_HEADERS" });
    }

    const rawBody = event.body || "{}";
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return reply(400, { error: "INVALID_JSON_PAYLOAD" });
    }

    const configuredWebhookId = process.env.PAYPAL_SANDBOX_WEBHOOK_ID || DEFAULT_WEBHOOK_ID;

    // 1. Cryptographic Signature Verification Gate
    // Strictly executed BEFORE idempotency lookups or state transitions.
    // Zero client-controlled bypass: body._test_mock_verified is never recognized.
    let isVerified = false;
    let verificationMethod = "NONE";

    if (customVerifier) {
      // Injected test verifier for programmatic isolated test harness
      const testResult = await customVerifier(headers, rawBody, configuredWebhookId);
      if (testResult && testResult.ok) {
        isVerified = true;
        verificationMethod = testResult.method || "LOCAL_TEST_HARNESS_VERIFIED";
      } else {
        await store.quarantineToDLQ({
          event_id: body.id || `EVT-${Date.now()}`,
          transmission_id: transmissionId,
          failure_reason: `CRYPTOGRAPHIC_SIGNATURE_INVALID: ${testResult ? testResult.reason : "TEST_VERIFIER_REJECTED"}`,
          attempt_count: 1,
          last_error_redacted: "Cryptographic signature validation failed against test authority."
        });
        return reply(401, {
          error: "CRYPTOGRAPHIC_SIGNATURE_INVALID",
          reason: testResult ? testResult.reason : "TEST_VERIFIER_REJECTED"
        });
      }
    } else {
      // Production path: strictly authentic PayPal REST API v2 verification
      if (!certUrl || !transmissionSig) {
        await store.quarantineToDLQ({
          event_id: body.id || `EVT-${Date.now()}`,
          transmission_id: transmissionId,
          failure_reason: "CRYPTOGRAPHIC_SIGNATURE_INVALID: SIGNATURE_VERIFICATION_REQUIRED",
          attempt_count: 1,
          last_error_redacted: "Missing cryptographic signature headers."
        });
        return reply(401, {
          error: "CRYPTOGRAPHIC_SIGNATURE_INVALID",
          reason: "SIGNATURE_VERIFICATION_REQUIRED"
        });
      }

      if (!isValidPayPalCertUrl(certUrl)) {
        return reply(403, {
          error: "SECURITY_REJECT_SSRF_ATTEMPT",
          message: "cert_url does not match official PayPal API certificate domains."
        });
      }

      const apiResult = await verifyWithPayPalApi(headers, rawBody, configuredWebhookId);
      if (apiResult && apiResult.ok) {
        isVerified = true;
        verificationMethod = apiResult.method || "PAYPAL_API_VERIFY";
      } else {
        await store.quarantineToDLQ({
          event_id: body.id || `EVT-${Date.now()}`,
          transmission_id: transmissionId,
          failure_reason: `CRYPTOGRAPHIC_SIGNATURE_INVALID: ${apiResult ? apiResult.reason : "VERIFICATION_FAILED"}`,
          attempt_count: 1,
          last_error_redacted: "Cryptographic signature validation failed against PayPal API."
        });
        return reply(401, {
          error: "CRYPTOGRAPHIC_SIGNATURE_INVALID",
          reason: apiResult ? apiResult.reason : "VERIFICATION_FAILED"
        });
      }
    }

    // 2. Multi-key Idempotency & Replay Defense (Gate AN)
    // Checked ONLY AFTER cryptographic verification has established authenticity
    const isDuplicate = await store.isWebhookDuplicate(transmissionId);
    if (isDuplicate) {
      return reply(200, {
        status: "ALREADY_PROCESSED_IDEMPOTENT_OK",
        message: `Transmission ID '${transmissionId}' has already been durably processed. Duplicate acknowledged without side effects.`,
        transmission_id: transmissionId
      });
    }

    // 3. Event Processing & Financial Reconciliation Gate
    const eventType = body.event_type;
    const eventId = body.id || `EVT-${Date.now()}`;
    const resource = body.resource || {};
    const captureId = resource.id;

    // Record audit trace of received webhook
    const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");
    const recResult = await store.recordWebhookEvent({
      transmission_id: transmissionId,
      event_id: eventId,
      event_type: eventType,
      resource_id: captureId || resource.parent_payment || "UNKNOWN",
      verification_status: isVerified ? "SUCCESS" : "FAILURE",
      verification_method: verificationMethod,
      payload_sha256: payloadHash,
      raw_payload: body
    });

    if (recResult && recResult.is_duplicate) {
      return reply(409, {
        error: "REPLAY_ATTACK_DETECTED",
        message: `Transmission ID '${transmissionId}' has already been processed or is currently being processed.`
      });
    }

    // Handle Capture Denied or Reversed
    if (eventType === "PAYMENT.CAPTURE.DENIED") {
      if (captureId) {
        await store.recordCaptureAtomic({
          capture_id: captureId,
          order_id: resource.supplementary_data?.related_ids?.order_id || "UNKNOWN",
          amount_usd: parseFloat(resource.amount?.value || "0"),
          currency: resource.amount?.currency_code || "USD",
          status: "DENIED"
        });
      }
      return reply(200, { status: "PROCESSED", action: "CAPTURE_DENIED_RECORDED" });
    }

    if (eventType === "PAYMENT.CAPTURE.REVERSED") {
      if (captureId) {
        await store.recordCaptureAtomic({
          capture_id: captureId,
          order_id: resource.supplementary_data?.related_ids?.order_id || "UNKNOWN",
          amount_usd: parseFloat(resource.amount?.value || "0"),
          currency: resource.amount?.currency_code || "USD",
          status: "REVERSED"
        });
      }
      return reply(200, { status: "PROCESSED", action: "CAPTURE_REVERSED_RECORDED" });
    }

    if (eventType !== "PAYMENT.CAPTURE.COMPLETED") {
      return reply(200, { status: "IGNORED", reason: `Event type ${eventType} does not trigger settlement.` });
    }

    // P0-SECURITY: Verify HMAC Delivery Secret exists before any settlement processing
    if (!tokenSecret || typeof tokenSecret !== "string" || tokenSecret.trim() === "") {
      return reply(500, {
        error: "SERVER_CONFIGURATION_ERROR",
        message: "Delivery signing secret is not configured on server. Token issuance aborted fail-closed."
      });
    }

    // 4. Order ID Resolution (P0-SECURITY: ZERO DEMO FALLBACK)
    let orderId = resource.supplementary_data?.related_ids?.order_id;
    if (!orderId && Array.isArray(resource.links)) {
      const orderLink = resource.links.find(l => l.rel === "up" || l.rel === "order");
      if (orderLink && orderLink.href) {
        const m = orderLink.href.match(/\/orders\/([A-Za-z0-9_-]+)/);
        if (m) orderId = m[1];
      }
    }
    if (!orderId && captureId && store.getOrderByCaptureId) {
      const existingOrderByCapture = await store.getOrderByCaptureId(captureId);
      if (existingOrderByCapture && existingOrderByCapture.order_id) {
        orderId = existingOrderByCapture.order_id;
      }
    }

    if (!orderId) {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: "REJECTED_UNRESOLVED_ORDER_IDENTIFIER: Webhook does not contain or correlate to a verified PayPal Order ID.",
        attempt_count: 1,
        last_error_redacted: "Missing financial order reference."
      });
      return reply(422, {
        error: "REJECTED_UNRESOLVED_ORDER_IDENTIFIER",
        message: "Webhook does not contain or correlate to an identifiable PayPal Order ID. Delivery prohibited."
      });
    }

    const capturedAmount = resource.amount?.value;
    const capturedCurrency = resource.amount?.currency_code;
    const eventCustomId = resource.custom_id;

    // Retrieve stored order from database
    let storedOrder = await store.getPayPalOrder(orderId);

    // GATE W: Orphan Webhook arrives before local order creation
    if (!storedOrder) {
      await store.recordWebhookInbox({
        transmission_id: transmissionId,
        event_id: eventId,
        event_type: eventType,
        order_id: orderId,
        capture_id: captureId,
        verification_status: isVerified ? "SUCCESS" : "FAILURE",
        verification_method: verificationMethod,
        processing_status: "PENDING_RECONCILIATION",
        payload_sha256: payloadHash,
        raw_payload: body
      });

      return reply(202, {
        status: "RECORDED_PENDING_RECONCILIATION",
        message: `Webhook cryptographically verified and recorded in durable inbox. Order '${orderId}' is pending local registration.`,
        transmission_id: transmissionId,
        order_id: orderId,
        capture_id: captureId
      });
    }

    // 5. Complete Mandate & Policy Binding Verification
    // A. Verify associated financial mandate exists and is active
    // P0-SECURITY: Zero fallback to demo mandate. Mandate must be explicitly bound in stored order.
    if (!storedOrder.mandate_id || typeof storedOrder.mandate_id !== "string" || storedOrder.mandate_id.trim() === "") {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: "REJECTED_MANDATE_BINDING_MISSING: Stored order record has no associated mandate ID.",
        attempt_count: 1,
        last_error_redacted: "Order record is missing institutional mandate binding."
      });
      return reply(422, {
        error: "REJECTED_MANDATE_BINDING_MISSING",
        message: "Stored order record has no associated mandate binding. Delivery prohibited."
      });
    }

    const mandateId = storedOrder.mandate_id;
    const mandate = await store.getMandate(mandateId);
    if (!mandate || mandate.is_active === false) {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: `REJECTED_MANDATE_INVALID: Mandate '${mandateId}' is missing, unauthorized, or inactive.`,
        attempt_count: 1,
        last_error_redacted: "Associated financial mandate is invalid or inactive."
      });
      return reply(422, {
        error: "REJECTED_MANDATE_INVALID",
        message: `Associated procurement mandate '${mandateId}' is not authorized or active.`
      });
    }

    // B. Verify Custom ID / Policy Audit Hash
    // Stored order is the trusted source of truth for the approved policy audit hash.
    const expectedCustomId = storedOrder.custom_id;
    if (!expectedCustomId || typeof expectedCustomId !== "string" || expectedCustomId.trim() === "") {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: "REJECTED_CUSTOM_ID_MISSING: Stored order record has no immutable policy audit hash.",
        attempt_count: 1,
        last_error_redacted: "Missing immutable policy audit hash in stored order."
      });
      return reply(422, {
        error: "REJECTED_CUSTOM_ID_MISSING",
        message: "Stored order record has no immutable policy audit hash. Delivery prohibited."
      });
    }

    // If custom_id is provided in the PayPal webhook resource, it MUST match the authorized hash
    if (eventCustomId && eventCustomId !== expectedCustomId) {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: `REJECTED_CUSTOM_ID_MISMATCH: Webhook custom_id '${eventCustomId}' does not match authorized '${expectedCustomId}'`,
        attempt_count: 1,
        last_error_redacted: "Custom ID does not match immutable policy audit hash."
      });
      return reply(422, {
        error: "REJECTED_CUSTOM_ID_MISMATCH",
        message: "Custom ID does not match immutable policy audit hash."
      });
    }

    // Trusted policy audit hash from authorized order record
    const verifiedPolicyHash = expectedCustomId;

    // C. Verify Merchant Whitelist
    const merchantId = storedOrder.merchant_id || resource.payee?.merchant_id;
    const authorizedMerchants = mandate.authorized_merchants || mandate.authorized_merchant_whitelist || [];
    if (!merchantId || !authorizedMerchants.includes(merchantId)) {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: `REJECTED_UNAUTHORIZED_MERCHANT: Merchant '${merchantId}' is not authorized in mandate whitelist.`,
        attempt_count: 1,
        last_error_redacted: "Payee merchant not in whitelist."
      });
      return reply(422, {
        error: "REJECTED_UNAUTHORIZED_MERCHANT",
        message: `Merchant '${merchantId}' is not authorized in institutional mandate whitelist.`
      });
    }

    // D. Verify Amount and Hard Budget Ceiling
    const expectedAmount = storedOrder.amount_usd.toFixed(2);
    if (capturedAmount !== expectedAmount) {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: `REJECTED_AMOUNT_MISMATCH: Captured $${capturedAmount} vs authorized $${expectedAmount}`,
        attempt_count: 1,
        last_error_redacted: "Captured amount does not match authorized order amount."
      });
      return reply(422, {
        error: "REJECTED_AMOUNT_MISMATCH",
        message: `Captured amount $${capturedAmount} does not match authorized $${expectedAmount}.`
      });
    }

    if (parseFloat(capturedAmount) > mandate.max_budget_usd) {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: `REJECTED_BUDGET_EXCEEDED: Captured $${capturedAmount} exceeds mandate budget cap $${mandate.max_budget_usd}`,
        attempt_count: 1,
        last_error_redacted: "Captured amount exceeds hard institutional budget."
      });
      return reply(422, {
        error: "REJECTED_BUDGET_EXCEEDED",
        message: `Captured amount $${capturedAmount} exceeds mandate ceiling $${mandate.max_budget_usd}.`
      });
    }

    // E. Verify Currency
    const expectedCurrency = storedOrder.currency || mandate.currency || "USD";
    if (capturedCurrency !== expectedCurrency) {
      await store.quarantineToDLQ({
        event_id: eventId,
        transmission_id: transmissionId,
        failure_reason: `REJECTED_CURRENCY_MISMATCH: Captured ${capturedCurrency} vs authorized ${expectedCurrency}`,
        attempt_count: 1,
        last_error_redacted: "Captured currency does not match authorized order currency."
      });
      return reply(422, {
        error: "REJECTED_CURRENCY_MISMATCH",
        message: `Captured currency ${capturedCurrency} does not match authorized ${expectedCurrency}.`
      });
    }

    // F. Verify Absence of Prior Delivery (No Replay / Duplicate Delivery)
    const priorDelivery = (await store.getDeliveryAuthorizationByOrder(orderId)) ||
                          (captureId && await store.getDeliveryAuthorizationByCapture(captureId));
    if (priorDelivery) {
      return reply(409, {
        error: "REPLAY_ATTACK_DETECTED",
        message: `Delivery authorization already exists for order '${orderId}' / capture '${captureId}'. Duplicate delivery suppressed.`
      });
    }

    // G. Verify HMAC Signing Secret is Explicitly Configured
    if (!tokenSecret || typeof tokenSecret !== "string" || tokenSecret.trim() === "") {
      return reply(500, {
        error: "SERVER_CONFIGURATION_ERROR",
        message: "Delivery signing secret is not configured on server. Token issuance aborted fail-closed."
      });
    }

    // Record in durable webhook_inbox as PROCESSED
    await store.recordWebhookInbox({
      transmission_id: transmissionId,
      event_id: eventId,
      event_type: eventType,
      order_id: orderId,
      capture_id: captureId,
      verification_status: isVerified ? "SUCCESS" : "FAILURE",
      verification_method: verificationMethod,
      processing_status: "PROCESSED",
      payload_sha256: payloadHash,
      raw_payload: body
    });

    // Record Verified Capture
    await store.recordCaptureAtomic({
      capture_id: captureId,
      order_id: orderId,
      amount_usd: parseFloat(capturedAmount),
      currency: capturedCurrency,
      status: "COMPLETED",
      captured_at: resource.create_time || new Date().toISOString()
    });

    // Issue Tokenized Single-Use Delivery Authorization
    const authSessionId = `SESSION-${orderId}`;
    const tokenMsg = `${authSessionId}:${orderId}:${captureId}:${capturedAmount}`;
    const deliveryToken = crypto.createHmac("sha256", tokenSecret).update(tokenMsg).digest("hex");

    try {
      await store.issueDeliveryAuthorizationAtomic({
        token: deliveryToken,
        order_id: orderId,
        capture_id: captureId,
        policy_audit_sha256: verifiedPolicyHash,
        authorized_asset_title: "BTC/USDC Multi-Venue Autonomous Audit Report (Tier-1)"
      });

      // Enqueue transactional outbox notification
      await store.enqueueOutbox({
        aggregate_type: "ORDER",
        aggregate_id: orderId,
        event_type: "ISSUE_DELIVERY_TOKEN",
        payload: { capture_id: captureId, delivery_token: deliveryToken }
      });
    } catch (err) {
      if (err.message && err.message.includes("UNIQUE_CONSTRAINT_VIOLATION")) {
        return reply(409, {
          error: "REPLAY_ATTACK_DETECTED",
          message: "Delivery authorization already exists for this capture/order."
        });
      }
      throw err;
    }

    return reply(200, {
      status: "PAYPAL_SETTLEMENT_VERIFIED",
      capture_id: captureId,
      order_id: orderId,
      delivery_token_issued: deliveryToken.slice(0, 16) + "...",
      settlement_state: "PAYPAL_SETTLEMENT_VERIFIED"
    });
  };
}

// Default export uses strictly authentic PayPal REST API v2 verification and server environment
const defaultHandler = createWebhookHandler();

exports.handler = defaultHandler;
exports.createWebhookHandler = createWebhookHandler;
exports.isValidPayPalCertUrl = isValidPayPalCertUrl;
exports.computeCrc32 = computeCrc32;
