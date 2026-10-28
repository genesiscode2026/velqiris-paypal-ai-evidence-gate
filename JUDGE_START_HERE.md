# JUDGE START HERE — VELQIRIS AGENTIC COMMERCE TRUST GATE
**Hackathon:** PayPal AI Hackathon (Devpost #1225851)  
**Track:** Developer API & AI Agent Commercial Governance  
**Verification Time:** < 5 seconds  
**Live Demo:** [VELQIRIS Trust Gate Dashboard](https://velqiris-acquisition.netlify.app/paypal-sandbox.html)  
**Official Contact:** `chitara.trading@proton.me`

---

## 1. What Is This Project?
**VELQIRIS — Agentic Commerce Trust Gate** is an institutional-grade commercial trust perimeter connecting autonomous AI procurement agents with the **PayPal REST API v2**.

> [!NOTE]
> **Hosted Demo vs. Full Local Architecture:**  
> The hosted page ([velqiris-acquisition.netlify.app/paypal-sandbox.html](https://velqiris-acquisition.netlify.app/paypal-sandbox.html)) is a limited PayPal Sandbox preview demonstrating interactive client-side policy evaluation and sandbox order initialization. For the full six-scenario working demo (with persistent PostgreSQL/SQLite storage, background reconciler daemon, and live evaluate API), follow the verification steps below in this repository.

Autonomous agents are increasingly authorized to purchase digital assets, compute services, and intelligence feeds. However, existing LLMs are vulnerable to hallucinated spending, over-budget drift, and prompt injection attacks embedded in untrusted vendor listings.

VELQIRIS solves this by enforcing a 5-layer non-bypassable architecture:
1. **Layer 1: Immutable Procurement Mandate:** Baseline institutional boundaries (**$25.00 USD hard budget cap**, maximum **30.0/100 risk tolerance ceiling**, merchant whitelist `528WKSF7HVQHA`).
2. **Layer 2: AI Decision Engine:** Dual-mode comparative reasoning: active offline Heuristic Epistemic Risk Engine (Multi-Criteria Utility $U(o)$ and Epistemic Uncertainty Quantification $\in [0, 1]$) with adversarial prompt injection sanitization, paired with an isolated backend LLM proxy architecture (`llm-proxy.js`) for schema-gated inference.
3. **Layer 3: Deterministic Policy Enforcement Gate:** Non-bypassable mathematical guard enforcing zero price tampering, zero budget overruns, and zero unauthorized merchants, outputting an immutable SHA-256 policy audit hash.
4. **Layer 4: Real PostgreSQL Storage Engine & Transactional Outbox:** Canonical 12-table schema, row-level locking (`FOR UPDATE SKIP LOCKED`), and Durable Webhook Inbox with Dead Letter Queue (DLQ).
5. **Layer 5: Local Reconciler Daemon & Single-Use Digital Delivery:** Recovers orphan PayPal webhooks arriving before local orders, enforces multi-key idempotency, and releases single-use HMAC-SHA256 digital release tokens.

### Canonical Parameters & 6 Reference Scenarios:
- **Baseline Candidate Offers:**
  - **Offer A (`OFFER-ALPHA-01`):** Price $19.00 USD, Risk 8.0/100, Quality 96.5/100 (Legitimate Merchant `528WKSF7HVQHA`)
  - **Offer B (`OFFER-BETA-02`):** Price $16.00 USD, Risk 78.5/100, Quality 58.0/100 (High-risk telemetry, 19.4% dispute rate)
  - **Offer C (`OFFER-GAMMA-03`):** Price $29.00 USD, Risk 4.5/100, Quality 99.0/100 (Institutional tier exceeding budget)
- **Scenario Execution Results:**
  - **Scenario 1 (Multi-Offer Evaluation):** Mandate ($25 cap, 30 risk) evaluates all 3 offers $\rightarrow$ Selects Offer A $\rightarrow$ `POLICY_APPROVED_FOR_PAYPAL_SETTLEMENT` $\rightarrow$ PayPal Order spec locked $\rightarrow$ Delivery released.
  - **Scenario 2 (Isolated Risk Stress Test):** Mandate configured with tighter risk ceiling (20.0), evaluating Offer B (Risk 78.5) $\rightarrow$ `POLICY_REJECT_RISK_THRESHOLD_EXCEEDED` $\rightarrow$ Intercepted fail-closed ($0 spent). *(Note: Offer B also fails baseline 30.0 limit).*
  - **Scenario 3 (Isolated Budget Stress Test):** Mandate configured with tighter budget cap ($20.00), evaluating Offer C ($29.00) $\rightarrow$ `POLICY_REJECT_BUDGET_EXCEEDED` $\rightarrow$ Intercepted fail-closed ($0 spent). *(Note: Offer C also fails baseline $25.00 limit).*
  - **Scenario 4 (Adversarial Prompt Injection):** Mandate evaluates malicious offer containing override directives $\rightarrow$ `SECURITY_REJECT_PROMPT_INJECTION` $\rightarrow$ Input sanitized, transaction blocked fail-closed.
  - **Scenario 5 (Asynchronous Orphan Webhook Recovery):** PayPal webhook arrives before local order $\rightarrow$ durable inbox queues event $\rightarrow$ order registered $\rightarrow$ local reconciler matches order and unlocks deliverable $\rightarrow$ `POLICY_APPROVED_FOR_PAYPAL_SETTLEMENT`.
  - **Scenario 6 (Forged & Replay Webhook Defense):** Fraudulent signature rejected with HTTP 401 (`SECURITY_REJECT_FORGED_WEBHOOK_SIGNATURE`); duplicate replay acknowledged idempotently with HTTP 200 (`ALREADY_PROCESSED_IDEMPOTENT_OK`) without side effects.

> [!IMPORTANT]
> **PayPal Sandbox Operations & Settlement Distinction:**  
> Orders generated via the official PayPal REST API v2 (`POST /v2/checkout/orders`, `intent: CAPTURE`) are verified in the developer sandbox with status `CREATED`. Post-capture settlement is verified through cryptographic RS256 webhook signatures and reconciler processing. Zero real capital ($0 USD) is disbursed. Status `CREATED` represents an authorized order specification, strictly separated from settled funds.

---

## 2. Quick Verification (Run in 1 Command)

### Prerequisites:
- **Node.js** >= 20
- **Python** 3.10+
- **Docker & Docker Compose** (Required for running the local PostgreSQL 16 container and real Outbox/Inbox row-leasing tests)

```bash
# 1. Install Node.js dependencies:
npm install

# 2. Start PostgreSQL Container & Local Reconciler Daemon:
./velqiris_services.sh start

# 3. Run the automated Mathematical Test Audit:
node scripts/audit_test_suite.js

# 4. (Optional) Run the local 6-scenario API server & UI:
python3 serve_local_api.py
# Open in browser: http://127.0.0.1:8080/paypal-sandbox.html

# 5. Stop services:
./velqiris_services.sh stop
```

### Complete Test Matrix (105 Unique Tests Declared, 105 PASS, 0 FAIL):
- `test/postgres-real-integration.test.js` (7 tests): Real PostgreSQL connection, 12 tables, transactional rollback, multi-connection concurrency, unique constraint enforcement, Outbox leasing with `FOR UPDATE SKIP LOCKED`, and DLQ quarantine.
- `test/local-reconciler.test.js` (3 tests): Local reconciler daemon lifecycle, orphan recovery cycle, concurrent disjoint worker leases, and graceful shutdown.
- `test/orphan-reconciliation.test.js` (5 tests): Webhook arrival before local order, delayed reconciliation, unreconcilable orphan DLQ quarantine, Outbox completion, and HTTP 200 idempotent retransmission acknowledgement.
- `test/llm-proxy.test.js` (9 tests): 16KB payload limit, client authority tampering defense (HTTP 403), prompt injection rejection (HTTP 400), server auth configuration enforcement (HTTP 503), anonymous live mode gating (HTTP 401), invalid client credential rejection (HTTP 401), authorized fail-closed (HTTP 503), deterministic ranking, and rate limiting (HTTP 429).
- `test/topology-hardening-15.test.js` (15 tests): Serverless race condition defense, multi-key deduplication, fail-closed storage abort, SSRF cert_url domain whitelisting, single-use token consumption, and capture denial/reversal.
- `test/agentic-procurement.test.js` & `test/paypal-sandbox.test.js` (9 tests): Serverless function handlers, deterministic MCDA engine mode verification, non-financial simulated settlement separation, zero-leak credential validation, and full scenario simulation.
- `alexa-simulation.test.js` & `lead-capture.test.js` (2 test suites, 13 checks): Data integrity, consensus pricing, rate limiting, and honeypot protection.
- `test_paypal_sandbox_client.py` (20 tests): Live OAuth token handling, PayPal REST v2 order payload creation, capture verification, webhook cryptographic signatures, and solvency limits.
- `test_paypal_server_engine.py` (16 tests): Process restart persistence, multithreaded webhook concurrency, direct capture transitions, asynchronous out-of-order webhooks, and single-use digital delivery tokens.
- `test_agentic_procurement_engine.py` (11 tests): Mandate limits ($25 budget, 30 risk ceiling), prompt injection sanitization, contradictory metrics detection, multi-criteria utility ranking, and SHA-256 audit hashing.
- `test_serve_local_api.py` (8 tests): Local API server health, static asset delivery, HEAD requests, directory traversal defense, explicit settlement mode labeling, and scenario execution (8 PASS in direct environment; SKIPPED in hermetic sandboxed socket policy).

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
- [Official P0 Release Manifest & Verification Proofs](./RELEASE_MANIFEST_P0.json)
- [Pre-Existing Technology Disclosure](./PREEXISTING_TECHNOLOGY.md)
- [Verification Evidence Log](./VERIFICATION_EVIDENCE.md)
- [Comprehensive P0 Audit Report](./P0_AUDIT.md)
