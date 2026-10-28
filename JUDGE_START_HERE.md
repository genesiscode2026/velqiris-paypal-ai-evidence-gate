# JUDGE START HERE — VELQIRIS AGENTIC COMMERCE TRUST GATE
**Hackathon:** PayPal AI Hackathon (Devpost #1225851)  
**Track:** Developer API & AI Agent Commercial Governance  
**Verification Time:** < 5 seconds  
**Live Demo:** [VELQIRIS Trust Gate Dashboard](https://velqiris-acquisition.netlify.app/paypal-sandbox.html)  
**Official Contact:** `chitara.trading@proton.me`

---

## 1. What Is This Project?
**VELQIRIS — Agentic Commerce Trust Gate** is an institutional-grade commercial trust perimeter connecting autonomous AI procurement agents with the **PayPal REST API v2**.

Autonomous agents are increasingly authorized to purchase digital assets, compute services, and intelligence feeds. However, existing LLMs are vulnerable to hallucinated spending, over-budget drift, and prompt injection attacks embedded in untrusted vendor listings.

VELQIRIS solves this by enforcing a 5-layer non-bypassable architecture:
1. **Layer 1: Immutable Procurement Mandate:** Hard budget ceiling ($25.00 USD), maximum risk tolerance (30.0/100), and institutional merchant whitelist.
2. **Layer 2: AI Decision Engine:** Dual-mode comparative reasoning (Online OpenAI-compatible LLM schema + Offline Multi-Criteria Utility $U(o)$ and Epistemic Uncertainty Quantification $\in [0, 1]$), equipped with prompt injection input sanitization.
3. **Layer 3: Deterministic Policy Enforcement Gate:** Non-bypassable mathematical guard enforcing zero price tampering, zero budget overruns, and zero unauthorized merchants, outputting an immutable SHA-256 policy audit hash.
4. **Layer 4: Real PostgreSQL Storage Engine & Transactional Outbox:** Canonical 12-table schema, row-level locking (`FOR UPDATE SKIP LOCKED`), and Durable Webhook Inbox with Dead Letter Queue (DLQ).
5. **Layer 5: Local Reconciler Daemon & Single-Use Digital Delivery:** Recovers orphan PayPal webhooks arriving before local orders, enforces multi-key idempotency, and releases single-use HMAC-SHA256 digital release tokens.

---

## 2. Quick Verification (Run in 1 Command)

```bash
# 1. Start PostgreSQL & Local Daemons:
./velqiris_services.sh start

# 2. Run the automated Mathematical Test Audit:
node scripts/audit_test_suite.js
```

### Complete Test Matrix (98 Unique Tests Declared, 94 PASS, 4 SKIPPED, 0 FAIL):
- `test/postgres-real-integration.test.js` (7 tests): Real PostgreSQL connection, 12 tables, transactional rollback, multi-connection concurrency, unique constraint enforcement, Outbox leasing with `FOR UPDATE SKIP LOCKED`, and DLQ quarantine.
- `test/local-reconciler.test.js` (3 tests): Local reconciler daemon lifecycle, orphan recovery cycle, concurrent disjoint worker leases, and graceful shutdown.
- `test/orphan-reconciliation.test.js` (5 tests): Webhook arrival before local order, delayed reconciliation, unreconcilable orphan DLQ quarantine, Outbox completion, and HTTP 200 idempotent retransmission acknowledgement.
- `test/llm-proxy.test.js` (7 tests): 16KB payload limit, client authority tampering defense (HTTP 403), prompt injection rejection (HTTP 400), anonymous live mode gating (HTTP 401), authorized fail-closed (HTTP 503), deterministic ranking, and rate limiting (HTTP 429).
- `test/topology-hardening-15.test.js` (15 tests): Serverless race condition defense, multi-key deduplication, fail-closed storage abort, SSRF cert_url domain whitelisting, single-use token consumption, and capture denial/reversal.
- `test/agentic-procurement.test.js` & `test/paypal-sandbox.test.js` (8 tests): Serverless function handlers, zero-leak credential validation, and full scenario simulation.
- `alexa-simulation.test.js` & `lead-capture.test.js` (2 test suites, 13 checks): Data integrity, consensus pricing, rate limiting, and honeypot protection.
- `test_paypal_sandbox_client.py` (20 tests): Live OAuth token handling, PayPal REST v2 order payload creation, capture verification, webhook cryptographic signatures, and solvency limits.
- `test_paypal_server_engine.py` (16 tests): Process restart persistence, multithreaded webhook concurrency, direct capture transitions, asynchronous out-of-order webhooks, and single-use digital delivery tokens.
- `test_agentic_procurement_engine.py` (11 tests): Mandate limits, risk rejection, prompt injection sanitization, contradictory metrics detection, multi-criteria utility ranking, and SHA-256 audit hashing.
- `test_serve_local_api.py` (4 tests): Local API server health and scenario endpoints (SKIPPED in sandboxed socket mode; 100% PASS in direct environment).

---

## 3. Key Components & Implementation Files

| Component | File | Responsibilities |
| :--- | :--- | :--- |
| **Real PostgreSQL Schema** | [`schema_postgresql.sql`](./schema_postgresql.sql) | Canonical DDL with 12 tables: mandates, orders, captures, inbox, outbox, DLQ, audit. |
| **Local Reconciler Daemon** | [`local-reconciler.js`](./local-reconciler.js) | Controlled async worker loop, row-level leasing with `SKIP LOCKED`, orphan recovery. |
| **Secure LLM Proxy** | [`netlify/functions/llm-proxy.js`](./netlify/functions/llm-proxy.js) | Server-side AI inference gateway with input sanitization, rate-limiting, and cost protection. |
| **PayPal Webhook Ingress** | [`netlify/functions/paypal-webhook.js`](./netlify/functions/paypal-webhook.js) | Cryptographic signature verification, SSRF defense, durable inbox ingress, DLQ routing. |
| **Service Controller** | [`velqiris_services.sh`](./velqiris_services.sh) | `start`, `stop`, `health`, and `test` operational commands. |
| **Interactive Dashboard** | [`paypal-sandbox.html`](./paypal-sandbox.html) | Live 6-scenario Agentic Commerce Trust Gate dashboard with real-time execution telemetry. |

---

## 4. Documentation & Audits

- [README.md](./README.md)
- [PayPal Sandbox Verification Report](./PAYPAL_SANDBOX_VERIFICATION.md)
- [Recorded Live Sandbox Order Receipt](./paypal_verified_execution_proof.json)
- [Pre-Existing Technology Disclosure](./PREEXISTING_TECHNOLOGY.md)
- [Verification Evidence Log](./VERIFICATION_EVIDENCE.md)
- [Comprehensive P0 Audit Report](./P0_AUDIT.md)
