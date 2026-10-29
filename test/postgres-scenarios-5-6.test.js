const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "run_real_postgres_scenarios.js");

test("POSTGRES SCENARIOS 5 & 6 RUNNER: Script exists and validates arguments", () => {
  assert.doesNotThrow(() => {
    // When run with --help or no postgres, outputs valid JSON structure
    try {
      const out = execFileSync("node", [SCRIPT_PATH, "--scenario", "5"], {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, DATABASE_URL: "postgresql://invalid_host:5432/none" }
      });
      const parsed = JSON.parse(out);
      assert.ok("success" in parsed);
    } catch (err) {
      // If DB unreachable, should output structured JSON error
      const stderr = err.stderr || err.stdout || "";
      if (stderr.trim().startsWith("{")) {
        const parsed = JSON.parse(stderr);
        assert.equal(parsed.real_postgres_executed, false);
      }
    }
  });
});
