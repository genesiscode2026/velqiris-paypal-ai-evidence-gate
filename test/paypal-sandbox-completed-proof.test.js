const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PY_SCRIPT = path.join(ROOT, "scripts", "execute_sandbox_completed_settlement.py");
const PG_RECONCILER_SCRIPT = path.join(ROOT, "scripts", "reconcile_live_paypal_capture_pg.js");
const PROOF_PATH = path.join(ROOT, "evidence_captures", "real_paypal_sandbox_completed_proof.json");

function canonicalJsonString(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonString).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJsonString(value[k]))
      .join(",") +
    "}"
  );
}

test("PAYPAL SANDBOX COMPLETED SUITE 1: Settlement and PostgreSQL reconciler scripts compile cleanly", () => {
  assert.ok(fs.existsSync(PY_SCRIPT), "execute_sandbox_completed_settlement.py must exist");
  assert.ok(fs.existsSync(PG_RECONCILER_SCRIPT), "reconcile_live_paypal_capture_pg.js must exist");

  assert.doesNotThrow(() => {
    execFileSync("python3", ["-m", "py_compile", PY_SCRIPT], { encoding: "utf-8" });
  }, "Python settlement pipeline must compile without syntax errors");

  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", PG_RECONCILER_SCRIPT], { encoding: "utf-8" });
  }, "PostgreSQL live capture reconciler must pass node --check");

  const { validateDatabaseTarget } = require(PG_RECONCILER_SCRIPT);
  assert.throws(
    () => validateDatabaseTarget("postgresql://velqiris_admin:pass@remote-prod.example.com:5432/velqiris_test_db"),
    /DATABASE_ISOLATION_ABORT/,
    "Reconciler must fail-closed on non-loopback database hosts"
  );
  assert.throws(
    () => validateDatabaseTarget("postgresql://velqiris_admin:pass@127.0.0.1:5432/production_db"),
    /DATABASE_ISOLATION_ABORT/,
    "Reconciler must fail-closed on non-test database names"
  );
});

test("PAYPAL SANDBOX COMPLETED SUITE 2: Cryptographic 6-layer COMPLETED settlement & webhook proof integrity", () => {
  assert.ok(fs.existsSync(PROOF_PATH), "real_paypal_sandbox_completed_proof.json must exist");
  const raw = fs.readFileSync(PROOF_PATH, "utf-8");
  const proof = JSON.parse(raw);

  const recordedSha = proof.proof_metadata?.artifact_sha256;
  assert.match(recordedSha || "", /^[a-f0-9]{64}$/, "artifact_sha256 must be a 64-char hex SHA-256 digest");

  const cloned = JSON.parse(raw);
  delete cloned.proof_metadata.artifact_sha256;
  const recomputedSha = crypto
    .createHash("sha256")
    .update(canonicalJsonString(cloned), "utf-8")
    .digest("hex");
  assert.equal(recomputedSha, recordedSha, "Recomputed canonical SHA-256 must match recorded artifact_sha256");

  // Layer 1 & 2: Local Neural AI -> Deterministic Policy Gate
  assert.equal(proof.layer_1_local_neural_ai.model, "qwen2.5:0.5b");
  assert.equal(proof.layer_1_local_neural_ai.recommended_offer_id, "OFFER-ALPHA-01");
  assert.equal(proof.layer_1_local_neural_ai.canonical_catalog_enforced, true);
  assert.equal(proof.layer_2_deterministic_policy_gate.approved, true);
  assert.equal(
    proof.layer_2_deterministic_policy_gate.verdict_code,
    "POLICY_APPROVED_FOR_PAYPAL_SETTLEMENT"
  );

  // Layer 3: Official PayPal Developer Sandbox COMPLETED Order & Capture
  const pp = proof.layer_3_paypal_sandbox_completed_settlement;
  assert.equal(pp.post_orders_v2_http_status, 201);
  assert.equal(pp.get_orders_v2_http_status, 200);
  assert.equal(pp.order_status, "COMPLETED");
  assert.equal(pp.payee_merchant_id, "528WKSF7HVQHA");
  assert.equal(pp.capture.status, "COMPLETED");
  assert.equal(pp.capture.final_capture, true);
  assert.equal(pp.capture.gross_amount_usd, "19.00");

  // Layer 4: Official PayPal Server Webhook (WH-...)
  const wh = proof.layer_4_paypal_official_webhook_event.event;
  assert.match(wh.id, /^WH-[A-Z0-9-]+$/, "Webhook event ID must be an official PayPal WH-... identifier");
  assert.equal(wh.event_type, "PAYMENT.CAPTURE.COMPLETED");
  assert.equal(wh.resource.id, pp.capture.capture_id);
  assert.equal(wh.resource.status, "COMPLETED");
  assert.equal(wh.resource.supplementary_data.related_ids.order_id, pp.order_id);

  // Layer 5 & 6: PostgreSQL 16 ACID Reconciliation & Single-Use HMAC Delivery Gate
  const pg = proof.layer_5_and_6_postgresql_16_reconciliation_and_delivery_gate;
  assert.equal(pg.reconciled, true);
  assert.equal(pg.order_state_transition.pre_reconciliation, "CREATED");
  assert.equal(pg.order_state_transition.post_reconciliation, "COMPLETED");
  assert.equal(pg.webhook_inbox_transition.final, "PROCESSED");
  assert.equal(pg.single_use_delivery_gate.first_consumption_granted, true);
  assert.equal(pg.single_use_delivery_gate.first_consumption_status, "DELIVERED_SUCCESS");
  assert.equal(pg.single_use_delivery_gate.second_replay_rejected_http_410, true);
  assert.equal(pg.single_use_delivery_gate.db_is_consumed_flag, true);

  // Cross-layer cryptographic custom_id binding
  const cid = proof.layer_2_deterministic_policy_gate.bound_custom_id;
  assert.match(cid, /^GATE_AUTH_[a-f0-9]{16}$/);
  assert.equal(pp.bound_custom_id, cid);
  assert.equal(pp.capture.custom_id, cid);
  assert.equal(wh.resource.custom_id, cid);
  assert.equal(pg.bound_custom_id, cid);
  assert.equal(proof.cryptographic_chain_invariants.real_currency_moved_usd, "0.00");
  assert.equal(proof.cryptographic_chain_invariants.virtual_sandbox_currency_captured_usd, "19.00");
});

test("PAYPAL SANDBOX COMPLETED SUITE 3: Proof artifact contains zero secrets, PANs, or private workstation paths", () => {
  const raw = fs.readFileSync(PROOF_PATH, "utf-8");
  assert.ok(!/\b4\d{15}\b/.test(raw), "Full 16-digit Sandbox test card PAN must be masked in proof artifact");
  assert.ok(!raw.includes("A21AA"), "OAuth2 bearer token prefix must never appear in proof artifact");
  assert.ok(!raw.includes("PAYPAL_SANDBOX_CLIENT_SECRET"), "Client secret identifier must not leak");
  assert.ok(!raw.includes("/Users/"), "Local workstation user paths must never appear in proof artifact");
});
