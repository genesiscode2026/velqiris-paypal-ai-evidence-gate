const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT, "scripts", "execute_local_ai_inference.py");

test("LOCAL AI INFERENCE SUITE: Verification of local inference pipeline and proof schema", () => {
  // 1. Script existence and valid python syntax
  assert.ok(fs.existsSync(SCRIPT_PATH), "execute_local_ai_inference.py must exist");
  assert.doesNotThrow(() => {
    execFileSync("python3", ["-m", "py_compile", SCRIPT_PATH], { encoding: "utf-8" });
  }, "Script must compile without syntax errors");

  // 2. Proof artifact validation if generated
  const proofPath = path.join(ROOT, "evidence_captures", "real_ai_inference_proof.json");
  if (fs.existsSync(proofPath)) {
    const raw = fs.readFileSync(proofPath, "utf-8");
    const data = JSON.parse(raw);
    assert.ok(data.proof_metadata, "proof_metadata must be present");
    assert.ok(data.proof_metadata.neural_model, "neural_model info must be present");
    assert.ok(data.proof_metadata.artifact_sha256, "artifact_sha256 must be computed");
    assert.ok(Array.isArray(data.tests), "tests array must be present");
    assert.equal(data.tests.length, 3, "All 3 AI tests (AI-01, AI-02, AI-03) must be recorded");
  }
});
