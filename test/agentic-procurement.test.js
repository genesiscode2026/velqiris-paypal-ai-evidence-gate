const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateProcurement, handler } = require("../netlify/functions/agentic-procurement.js");

test("Scenario 1: Evaluates and Approves Offer A ($19.00) with SHA-256 Audit Hash", async () => {
  const result = await evaluateProcurement(1);
  assert.equal(result.ai_decision.status, "OFFER_RECOMMENDED");
  assert.equal(result.ai_decision.recommended_offer_id, "OFFER-ALPHA-01");
  assert.equal(result.policy_verdict.approved, true);
  assert.equal(result.policy_verdict.verdict_code, "POLICY_APPROVED_FOR_PAYPAL_SETTLEMENT");
  assert.equal(result.policy_verdict.authorized_order_spec.amount_usd, "19.00");
  assert.equal(typeof result.policy_verdict.policy_audit_sha256, "string");
  assert.equal(result.policy_verdict.policy_audit_sha256.length, 64);
  assert.equal(result.delivery_result.delivered, true);
});

test("Scenario 2: High Risk Offer B ($16.00) Rejected Fail-Closed", async () => {
  const result = await evaluateProcurement(2);
  assert.equal(result.ai_decision.status, "ALL_OFFERS_REJECTED");
  assert.equal(result.policy_verdict.approved, false);
  assert.equal(result.delivery_result.delivered, false);
});

test("Scenario 3: Over-Budget Offer C ($29.00) Blocked by Hard Mandate Cap", async () => {
  const result = await evaluateProcurement(3);
  assert.equal(result.ai_decision.status, "ALL_OFFERS_REJECTED");
  assert.equal(result.policy_verdict.approved, false);
  assert.equal(result.delivery_result.delivered, false);
});

test("Scenario 4: Prompt Injection Attack Sanitized and Blocked", async () => {
  const result = await evaluateProcurement(4);
  assert.equal(result.ai_decision.injection_detected, true);
  assert.equal(result.policy_verdict.approved, false);
  assert.equal(result.delivery_result.delivered, false);
});

test("HTTP Handler: Responds to POST with status 200 and JSON payload", async () => {
  const response = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ scenario: 1 })
  });
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.policy_verdict.approved, true);
});
