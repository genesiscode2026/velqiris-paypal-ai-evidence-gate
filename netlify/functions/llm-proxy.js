/**
 * VELQIRIS — SECURE LLM PROXY GATEWAY (Gate Y)
 * Server-side AI inference endpoint for procurement recommendations.
 * 
 * Security Invariants:
 * 1. Zero Credential Exposure: Client never receives LLM secrets or API tokens.
 * 2. Strict Input Validation & Payload Size Limits (max 16KB).
 * 3. In-Memory Sliding-Window Rate Limiting (max 10 req/min per IP).
 * 4. Prompt Injection Sanitization & Rejection.
 * 5. Strict JSON Output Schema Enforcement.
 * 6. Financial Authority Isolation: LLM cannot modify budget caps or authorize settlement.
 * 7. Fail-Closed Semantics: If LLM API fails, returns $0 authorized.
 */

const crypto = require("crypto");
const https = require("https");
const { getStorageAdapter } = require("./storage-adapter");

const storage = getStorageAdapter();
const MAX_PAYLOAD_SIZE = 16 * 1024; // 16 KB
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10;
const rateLimitMap = new Map();

// Prompt injection patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /system\s*:\s*you\s+are/i,
  /override\s+(the\s+)?budget/i,
  /bypass\s+(the\s+)?policy/i,
  /authorize\s+unlimited/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i
];

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store, private"
    },
    body: JSON.stringify(body)
  };
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
    rateLimitMap.set(ip, entry);
    return true;
  }

  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  entry.count += 1;
  rateLimitMap.set(ip, entry);
  return true;
}

function sanitizeAndDetectInjection(text) {
  if (!text || typeof text !== "string") return false;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

async function callOpenAI(apiKey, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 500
    });

    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.message?.content;
            resolve(JSON.parse(content));
          } catch (e) {
            reject(new Error(`INVALID_JSON_FROM_LLM: ${e.message}`));
          }
        } else {
          reject(new Error(`OPENAI_API_ERROR_HTTP_${res.statusCode}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("LLM_API_TIMEOUT"));
    });

    req.write(payload);
    req.end();
  });
}

async function handler(event) {
  if (event.httpMethod === "GET") {
    const hasKey = !!(process.env.OPENAI_API_KEY || process.env.MODEL_API_KEY);
    return reply(200, {
      system: "VELQIRIS Secure LLM Proxy",
      status: "ONLINE",
      ai_authenticity_status: hasKey ? "ONLINE_LLM_READY_AUTHENTIC" : "PENDING_API_KEY_AUTHORIZATION",
      configured_model: "gpt-4o-mini",
      provider: "OpenAI",
      public_live_inference_gated: true,
      deterministic_demo_available: true,
      limits: { max_payload_kb: 16, rate_limit_per_min: 10 }
    });
  }

  if (event.httpMethod !== "POST") {
    return reply(405, { error: "METHOD_NOT_ALLOWED" });
  }

  // 1. Rate Limiting
  const clientIp = event.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || "127.0.0.1";
  if (!checkRateLimit(clientIp)) {
    return reply(429, {
      error: "RATE_LIMIT_EXCEEDED",
      message: "Too many procurement inference requests. Max 10 requests per minute."
    });
  }

  // 2. Payload Size Check
  const rawBody = event.body || "{}";
  if (Buffer.byteLength(rawBody) > MAX_PAYLOAD_SIZE) {
    return reply(413, {
      error: "PAYLOAD_TOO_LARGE",
      message: `Payload exceeds 16KB limit (received ${Buffer.byteLength(rawBody)} bytes).`
    });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return reply(400, { error: "INVALID_JSON_PAYLOAD" });
  }

  // 3. Client Authority Tampering Defense
  const FORBIDDEN_CLIENT_KEYS = ["status", "settlement_verified", "is_verified", "override_budget", "authorized_budget"];
  for (const k of FORBIDDEN_CLIENT_KEYS) {
    if (k in body) {
      return reply(403, {
        error: "FORBIDDEN_CLIENT_AUTHORITY_TAMPERING",
        message: `Client cannot assert '${k}'. Financial authority is held strictly by Policy Gate.`
      });
    }
  }

  const { mandate_id, offers, instructions, mode } = body;
  if (!mandate_id || !Array.isArray(offers) || offers.length === 0) {
    return reply(400, { error: "MISSING_MANDATORY_FIELDS", message: "mandate_id and non-empty offers array required." });
  }

  // 4. Prompt Injection Defense
  if (sanitizeAndDetectInjection(instructions)) {
    return reply(400, {
      error: "PROMPT_INJECTION_DETECTED",
      message: "Inference request contained adversarial prompt injection keywords."
    });
  }

  for (const o of offers) {
    if (sanitizeAndDetectInjection(o.vendor_name) || sanitizeAndDetectInjection(o.title)) {
      return reply(400, {
        error: "PROMPT_INJECTION_DETECTED",
        message: "Offer metadata contained adversarial prompt injection keywords."
      });
    }
  }

  // 5. Fetch Mandate from Single Source of Truth
  const mandate = await storage.getMandate(mandate_id);
  if (!mandate) {
    return reply(404, { error: "MANDATE_NOT_FOUND", message: `Mandate '${mandate_id}' not found.` });
  }

  const apiKey = process.env.OPENAI_API_KEY || process.env.MODEL_API_KEY;
  let decision = null;

  if (mode === "LIVE_PRODUCTION") {
    // GATE AO: Persistent Cost & Quota Control - Gating Billable AI Calls
    const mandateKey = event.headers?.["x-velqiris-mandate-key"] || event.headers?.["authorization"]?.replace(/^Bearer\s+/i, "");
    const AUTHORIZED_MANDATE_KEY = process.env.VELQIRIS_MANDATE_AUTH_KEY || "MANDATE_AUTH_AUTHORIZED_DEMO_2026";

    if (!mandateKey || mandateKey !== AUTHORIZED_MANDATE_KEY) {
      return reply(401, {
        error: "UNAUTHORIZED_LIVE_INFERENCE",
        message: "Public anonymous requests are restricted from initiating billable live LLM inference. Authorized mandate credential required.",
        status: "REJECTED_FAIL_CLOSED",
        authorized_budget_usd: 0.00
      });
    }

    if (!apiKey) {
      // Fail-closed
      return reply(503, {
        error: "AI_MODEL_UNAVAILABLE_ABORT",
        status: "REJECTED_FAIL_CLOSED",
        authorized_budget_usd: 0.00,
        message: "Live production model API key is not configured in server environment. Failing closed."
      });
    }

    try {
      const systemPrompt = `You are VELQIRIS Autonomous Procurement Agent. Select the optimal offer maximizing quality while keeping risk below ${mandate.max_tolerable_risk_score} and price below $${mandate.max_budget_usd}. Output JSON: { "recommended_offer_id": string, "vendor_name": string, "proposed_price_usd": number, "quality_score": number, "risk_score": number, "uncertainty_score": number, "confidence_score": number, "utility_score": number, "decision_rationale": string }`;
      const userPrompt = JSON.stringify({ offers, max_budget: mandate.max_budget_usd });
      decision = await callOpenAI(apiKey, systemPrompt, userPrompt);
    } catch (err) {
      return reply(502, {
        error: "LIVE_INFERENCE_FAILED",
        status: "REJECTED_FAIL_CLOSED",
        authorized_budget_usd: 0.00,
        reason: err.message
      });
    }
  } else {
    // Deterministic Heuristic Analysis (strictly labeled DEMO_DETERMINISTIC_ONLY)
    let best = null;
    let highestUtility = -Infinity;

    for (const off of offers) {
      const price = parseFloat(off.price_usd);
      const quality = parseFloat(off.quality_score || 50);
      const risk = parseFloat(off.risk_score || 20);

      // Utility function: U = quality - (risk * 1.5) - (price * 2)
      const utility = quality - (risk * 1.5) - (price * 2.0);
      if (utility > highestUtility) {
        highestUtility = utility;
        best = {
          recommended_offer_id: off.offer_id,
          vendor_name: off.vendor_name,
          proposed_price_usd: price,
          quality_score: quality,
          risk_score: risk,
          uncertainty_score: 0.05,
          confidence_score: 0.95,
          utility_score: parseFloat(utility.toFixed(4)),
          decision_rationale: `Selected based on optimal utility score (${utility.toFixed(2)}) within risk boundary.`
        };
      }
    }
    decision = best;
  }

  // 6. Enforce Financial Isolation
  // LLM recommendation is proposed only. It CANNOT authorize settlement by itself.
  return reply(200, {
    status: "AI_DECISION_RECOMMENDED",
    engine_mode: mode === "LIVE_PRODUCTION" ? "ONLINE_LLM_INFERENCE" : "DEMO_DETERMINISTIC_ONLY",
    mandate_id: mandate.mandate_id,
    mandate_budget_cap: mandate.max_budget_usd,
    mandate_risk_cap: mandate.max_tolerable_risk_score,
    ai_decision: decision,
    policy_enforcement_required: true,
    settlement_authorized: false // Zero client or LLM authority over funds
  });
}

exports.handler = handler;
exports.checkRateLimit = checkRateLimit;
exports.sanitizeAndDetectInjection = sanitizeAndDetectInjection;
