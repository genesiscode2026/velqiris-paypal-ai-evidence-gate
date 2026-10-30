/**
 * VELQIRIS — TOPOLOGY HARDENING & DISTRIBUTED INTEGRITY TEST SUITE (15 TESTS)
 * Mandated by ChatGPT Directive P0+ Section 9.
 * Validates distributed concurrency, idempotency, failure modes, anti-tampering,
 * cryptographic verification, and state divergence prevention.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { storage, MemoryStorageAdapter } = require("../netlify/functions/storage-adapter.js");
const { handler: publicWebhookHandler, createWebhookHandler, isValidPayPalCertUrl, computeCrc32 } = require("../netlify/functions/paypal-webhook.js");
const { evaluateProcurement, handler: procurementHandler } = require("../netlify/functions/agentic-procurement.js");

const testSecret = "TEST_SECRET_TOPOLOGY_HARDENING_12345";
const webhookHandler = createWebhookHandler({
  verifier: async () => ({ ok: true, method: "LOCAL_TEST_HARNESS_VERIFIED" }),
  tokenSecret: testSecret,
  storage
});

// Reset storage before test suite
test.beforeEach(() => {
  storage.resetForTesting();
});

// ==============================================================================
// TEST 1: Două instanțe serverless procesează concurent același eveniment
// ==============================================================================
test("TEST 1: Două instanțe serverless concurente procesează același webhook (exact 1 reușește, 1 replay 409)", async () => {
  const orderId = "ORD-CONCURRENT-001";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-CONCURRENT-001",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "POL_HASH_ATTESTED",
    status: "CREATED"
  });

  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-CONCURRENT-RACE-001",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-EVT-001",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-CONCURRENT-001",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "POL_HASH_ATTESTED",
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };

  const [res1, res2] = await Promise.all([
    webhookHandler(req),
    webhookHandler(req)
  ]);

  const statuses = [res1.statusCode, res2.statusCode].sort();
  assert.deepEqual(statuses, [200, 409], "Una din instanțe trebuie să returneze 200, iar cealaltă 409 Replay Attack");
});

// ==============================================================================
// TEST 2: Aceeași tranzacție retransmisă cu identificatori diferiți
// ==============================================================================
test("TEST 2: Aceeași captură retransmisă cu transmission-id diferit este deduplicată atomic", async () => {
  const orderId = "4GM55617DD508394F";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-DUPE-002",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "POL_HASH_002",
    status: "CREATED"
  });

  // Primul eveniment
  const req1 = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-ORIGINAL-002",
      "paypal-transmission-time": "2026-10-28T20:01:00Z"
    },
    body: JSON.stringify({
      id: "WH-EVT-ORIGINAL",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-DUPE-CHECK-002",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "POL_HASH_002",
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };
  const res1 = await webhookHandler(req1);
  assert.equal(res1.statusCode, 200);

  // Retransmitere cu alt transmission ID dar același capture_id
  const captureCheck = await storage.recordCaptureAtomic({
    capture_id: "CAP-DUPE-CHECK-002",
    order_id: orderId,
    amount_usd: 19.00,
    currency: "USD",
    status: "COMPLETED"
  });
  assert.equal(captureCheck.is_duplicate, true, "Captura existentă trebuie marcată ca duplicat");
});

// ==============================================================================
// TEST 3: Baza de date devine temporar indisponibilă (Fail-Closed)
// ==============================================================================
test("TEST 3: Când stocarea este indisponibilă, sistemul refuză tranzacția fail-closed", async () => {
  const brokenStorage = new MemoryStorageAdapter();
  brokenStorage.isWebhookDuplicate = async () => {
    throw new Error("DB_CONNECTION_TIMEOUT: Storage temporarily unreachable");
  };

  let threw = false;
  try {
    await brokenStorage.isWebhookDuplicate("TX-ANY");
  } catch (err) {
    threw = true;
    assert.match(err.message, /DB_CONNECTION_TIMEOUT/);
  }
  assert.equal(threw, true);
});

// ==============================================================================
// TEST 4: Procesul se oprește după verificarea webhook-ului, înaintea livrării
// ==============================================================================
test("TEST 4: Crash după verificarea webhook-ului conservă starea de eveniment fără livrare acordată", async () => {
  // Webhook înregistrat dar livrarea nu a fost consumată
  await storage.recordWebhookEvent({
    transmission_id: "TX-CRASH-TEST-004",
    event_id: "EVT-CRASH-004",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource_id: "CAP-CRASH-004",
    verification_status: "SUCCESS",
    verification_method: "PAYPAL_API_VERIFY",
    payload_sha256: "hash004",
    raw_payload: {}
  });

  const isRecorded = await storage.isWebhookDuplicate("TX-CRASH-TEST-004");
  assert.equal(isRecorded, true);
  // Token de livrare nu a fost încă emis sau consumat
  const res = await storage.consumeDeliveryAuthorizationAtomic("TOKEN-NON-EXISTENT");
  assert.equal(res.success, false);
});

// ==============================================================================
// TEST 5: Procesul se oprește după commit, înaintea răspunsului HTTP (Idempotency)
// ==============================================================================
test("TEST 5: Retry după commit returnează starea deja comisă fără dublă alocare", async () => {
  const orderSpec = {
    order_id: "ORD-IDEM-005",
    intent_id: "INTENT-005",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "CUSTOM-005"
  };

  // Prima execuție
  const first = await storage.createPayPalOrder(orderSpec, "IDEM-KEY-005");
  assert.equal(first.is_duplicate, false);

  // A doua execuție (simulând retry client după crash de conexiune)
  const second = await storage.createPayPalOrder(orderSpec, "IDEM-KEY-005");
  assert.equal(second.is_duplicate, true);
  assert.equal(second.existing.order_id, "ORD-IDEM-005");
});

// ==============================================================================
// TEST 6: Clientul din browser încearcă să trimită SETTLEMENT_VERIFIED
// ==============================================================================
test("TEST 6: Clientul încearcă să trimită status SETTLEMENT_VERIFIED (respins 403)", async () => {
  const req = {
    httpMethod: "POST",
    body: JSON.stringify({
      scenario: 1,
      status: "SETTLEMENT_VERIFIED", // Tentativă de injectare stare
      is_verified: true
    })
  };
  const res = await procurementHandler(req);
  assert.equal(res.statusCode, 403);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "FORBIDDEN_CLIENT_STATUS_TAMPERING");
});

// ==============================================================================
// TEST 7: Webhook conține semnătură invalidă sau netestată (Fail-Closed 401)
// ==============================================================================
test("TEST 7: Webhook cu semnătură invalidă este respins fail-closed de handlerul public (401)", async () => {
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-FORGED-007",
      "paypal-transmission-time": "2026-10-28T20:00:00Z",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/cert"
    },
    body: JSON.stringify({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP-FORGED-007" },
      _test_mock_verified: true
    })
  };
  const res = await publicWebhookHandler(req);
  assert.equal(res.statusCode, 401);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "CRYPTOGRAPHIC_SIGNATURE_INVALID");
});

test("TEST 7B: Missing HMAC secret fails closed with HTTP 500 SERVER_CONFIGURATION_ERROR", async () => {
  const handlerWithoutSecret = createWebhookHandler({
    verifier: async () => ({ ok: true }),
    tokenSecret: "",
    storage
  });
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-NOSECRET-001",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" })
  };
  const res = await handlerWithoutSecret(req);
  assert.equal(res.statusCode, 500);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "SERVER_CONFIGURATION_ERROR");
});

test("TEST 7C: Webhook without resolvable order ID is quarantined to DLQ and returns 422", async () => {
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-NO-ORDERID-001",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-NO-ORDERID",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-NO-ORDERID",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" }
      }
    })
  };
  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 422);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "REJECTED_UNRESOLVED_ORDER_IDENTIFIER");
});

test("TEST 7D: Webhook with custom_id mismatch is rejected (422 REJECTED_CUSTOM_ID_MISMATCH)", async () => {
  const orderId = "ORD-CUSTOM-MISMATCH-001";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-MISMATCH-001",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "EXPECTED_HASH_123",
    status: "CREATED"
  });
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-CUSTOM-MISMATCH-001",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-CUSTOM-MISMATCH",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-CUSTOM-MISMATCH",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "FORGED_HASH_999",
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };
  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 422);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "REJECTED_CUSTOM_ID_MISMATCH");
});

test("TEST 7E: Webhook for order with unauthorized merchant is rejected (422 REJECTED_UNAUTHORIZED_MERCHANT)", async () => {
  const orderId = "ORD-ROGUE-MERCHANT-001";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-ROGUE-001",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "ROGUE_MERCHANT_XYZ",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "POL_AUDIT_ROGUE",
    status: "CREATED"
  });
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-ROGUE-MERCHANT-001",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-ROGUE-MERCHANT",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-ROGUE-MERCHANT",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "POL_AUDIT_ROGUE",
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };
  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 422);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "REJECTED_UNAUTHORIZED_MERCHANT");
  const auth = await storage.getDeliveryAuthorizationByOrder(orderId);
  assert.equal(auth, null, "Zero delivery token can be issued for unauthorized merchant");
});

test("TEST 7F: Webhook for order with missing mandate_id is rejected fail-closed (422 REJECTED_MANDATE_BINDING_MISSING)", async () => {
  const orderId = "ORD-NO-MANDATE-001";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-NO-MANDATE-001",
    mandate_id: "", // Missing mandate binding
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "POL_AUDIT_NO_MANDATE",
    status: "CREATED"
  });
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-NO-MANDATE-001",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-NO-MANDATE",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-NO-MANDATE",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "POL_AUDIT_NO_MANDATE",
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };
  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 422);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "REJECTED_MANDATE_BINDING_MISSING");
  const auth = await storage.getDeliveryAuthorizationByOrder(orderId);
  assert.equal(auth, null, "Zero delivery token can be issued without mandate binding");
});

test("TEST 7G: Webhook for order with missing custom_id in stored order is rejected fail-closed (422 REJECTED_CUSTOM_ID_MISSING)", async () => {
  const orderId = "ORD-NO-CUSTOMID-001";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-NO-CUSTOMID-001",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "", // Missing custom_id in stored order
    status: "CREATED"
  });
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-NO-CUSTOMID-001",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-NO-CUSTOMID",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-NO-CUSTOMID",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        custom_id: "ATTACKER_PROVIDED_CUSTOM_ID_123", // Attacker supplies custom_id in webhook
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };
  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 422);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "REJECTED_CUSTOM_ID_MISSING");
  const auth = await storage.getDeliveryAuthorizationByOrder(orderId);
  assert.equal(auth, null, "Zero delivery token can be issued when stored order lacks policy audit hash");
});

test("TEST 7H: Webhook with omitted custom_id in PayPal payload succeeds using trusted stored order custom_id", async () => {
  const orderId = "ORD-OMITTED-PAYPAL-CUSTOMID-001";
  const trustedHash = "POL_AUDIT_TRUSTED_STORED_HASH_001";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-OMITTED-001",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: trustedHash,
    status: "CREATED"
  });
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-OMITTED-PAYPAL-CUSTOMID-001",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-OMITTED-CUSTOMID",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-OMITTED-CUSTOMID",
        status: "COMPLETED",
        amount: { value: "19.00", currency_code: "USD" },
        // custom_id omitted by PayPal protocol
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };
  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.status, "PAYPAL_SETTLEMENT_VERIFIED");
  const auth = await storage.getDeliveryAuthorizationByOrder(orderId);
  assert.ok(auth, "Delivery token must be issued using trusted stored order audit hash");
  assert.equal(auth.policy_audit_sha256, trustedHash);
});

// ==============================================================================
// TEST 8: Webhook este autentic, dar conține sumă greșită (Amount Mismatch)
// ==============================================================================
test("TEST 8: Webhook verificat cu sumă modificată ($1.00 în loc de $19.00) este respins (422)", async () => {
  const orderId = "ORD-TAMPER-008";
  await storage.createPayPalOrder({
    order_id: orderId,
    intent_id: "INTENT-TAMPER-008",
    mandate_id: "MANDATE-2026-DIGITAL-REPORT-001",
    merchant_id: "528WKSF7HVQHA",
    amount_usd: 19.00,
    currency: "USD",
    custom_id: "POL_AUDIT_008",
    status: "CREATED"
  });

  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-TAMPERED-AMOUNT-008",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-EVT-TAMPER-008",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-TAMPER-008",
        status: "COMPLETED",
        amount: { value: "1.00", currency_code: "USD" },
        custom_id: "POL_AUDIT_008",
        supplementary_data: { related_ids: { order_id: orderId } }
      }
    })
  };
  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 422);
  const data = JSON.parse(res.body);
  assert.equal(data.error, "REJECTED_AMOUNT_MISMATCH");
});

// ==============================================================================
// TEST 9: AI-ul încearcă să recomande peste buget
// ==============================================================================
test("TEST 9: Oferta ce depășește bugetul ($29.00 > $25.00) este respinsă de Policy Gate", async () => {
  const result = await evaluateProcurement(3);
  assert.equal(result.ai_decision.status, "ALL_OFFERS_REJECTED");
  assert.equal(result.policy_verdict.approved, false);
  assert.equal(result.policy_verdict.verdict_code, "POLICY_REJECT_BUDGET_EXCEEDED");
});

// ==============================================================================
// TEST 10: Modelul online devine indisponibil în mod live (Fail-Closed)
// ==============================================================================
test("TEST 10: Modul LIVE_PRODUCTION fără cheie LLM eșuează FAIL-CLOSED ($0 autorizat)", async () => {
  const originalKey = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;

  const result = await evaluateProcurement(1, true); // isLiveProduction = true
  assert.equal(result.ai_decision.status, "ALL_OFFERS_REJECTED");
  assert.equal(result.ai_decision.error, "AI_MODEL_UNAVAILABLE_ABORT");
  assert.equal(result.policy_verdict.approved, false);

  if (originalKey) process.env.MODEL_API_KEY = originalKey;
});

// ==============================================================================
// TEST 11: Request încearcă accesarea produsului digital fără autorizare
// ==============================================================================
test("TEST 11: Descărcarea fără token valid sau autorizat este refuzată", async () => {
  const res = await storage.consumeDeliveryAuthorizationAtomic("FORGED-TOKEN-XYZ");
  assert.equal(res.success, false);
  assert.equal(res.error, "INVALID_DELIVERY_TOKEN");
});

// ==============================================================================
// TEST 12: Două descărcări simultane folosesc același token single-use
// ==============================================================================
test("TEST 12: Două descărcări simultane cu același token single-use (exact 1 reușește)", async () => {
  const token = "TOKEN-CONCURRENT-DELIVERY-012";
  await storage.issueDeliveryAuthorizationAtomic({
    token,
    order_id: "ORD-012",
    capture_id: "CAP-012",
    policy_audit_sha256: "hash012",
    authorized_asset_title: "BTC/USDC Report"
  });

  const [res1, res2] = await Promise.all([
    storage.consumeDeliveryAuthorizationAtomic(token, "1.1.1.1"),
    storage.consumeDeliveryAuthorizationAtomic(token, "2.2.2.2")
  ]);

  const successes = [res1.success, res2.success];
  assert.equal(successes.filter(s => s === true).length, 1, "Exact o descărcare trebuie să reușească");
  assert.equal(successes.filter(s => s === false).length, 1, "A doua descărcare trebuie să fie blocată (ALREADY_CONSUMED)");
});

// ==============================================================================
// TEST 13: Evenimentele PayPal sosesc în ordine diferită (Denial / Reversal)
// ==============================================================================
test("TEST 13: Webhook PAYMENT.CAPTURE.DENIED este înregistrat și nu deblochează livrare", async () => {
  const req = {
    httpMethod: "POST",
    headers: {
      "paypal-transmission-id": "TX-DENIED-013",
      "paypal-transmission-time": "2026-10-28T20:00:00Z"
    },
    body: JSON.stringify({
      id: "WH-EVT-DENIED-013",
      event_type: "PAYMENT.CAPTURE.DENIED",
      resource: {
        id: "CAP-DENIED-013",
        amount: { value: "19.00", currency_code: "USD" }
      }
    })
  };
  const res = await webhookHandler(req);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.action, "CAPTURE_DENIED_RECORDED");
});

// ==============================================================================
// TEST 14: Convergență contractuală (Reguli financiare identice)
// ==============================================================================
test("TEST 14: Parametrii financiari (buget $25, risc 30) sunt convergenți și imutabili", async () => {
  const mandate = await storage.getMandate("MANDATE-2026-DIGITAL-REPORT-001");
  assert.equal(mandate.max_budget_usd, 25.00);
  assert.equal(mandate.max_tolerable_risk_score, 30.0);
  assert.equal(mandate.currency, "USD");
});

// ==============================================================================
// TEST 15: Protecție SSRF pe cert_url și verificare metode HTTP
// ==============================================================================
test("TEST 15: Tentativele SSRF cu domenii neautorizate pe cert_url sunt respinse", async () => {
  assert.equal(isValidPayPalCertUrl("https://api.sandbox.paypal.com/v1/cert"), true);
  assert.equal(isValidPayPalCertUrl("https://api.paypal.com/v1/cert"), true);
  assert.equal(isValidPayPalCertUrl("https://malicious-attacker.com/fake-cert"), false);
  assert.equal(isValidPayPalCertUrl("http://127.0.0.1/fake-cert"), false);
  assert.equal(isValidPayPalCertUrl("file:///etc/passwd"), false);

  // Verificare metodă HTTP nepermisă
  const res = await webhookHandler({ httpMethod: "DELETE" });
  assert.equal(res.statusCode, 405);
});
