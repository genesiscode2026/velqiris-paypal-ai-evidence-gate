# JUDGE START HERE — VELQIRIS PAYPAL AI EVIDENCE GATE
**Hackathon:** PayPal AI Hackathon (Devpost #1225851)  
**Track:** Developer API & AI Agent Commercial Governance  
**Verification Time:** < 10 seconds  

---

## 1. What Is This Project?
An autonomous commercial payment and dispute guard that bridges AI agents with the **PayPal REST API v2**. It enforces bi-directional pre-transaction risk auditing, securely triggers sandbox checkouts, and unlocks deliverables (market intelligence, proof packets) only upon cryptographically verified order capture and webhook validation.

---

## 2. Quick Verification (Run in 1 Command)

```bash
# Run the complete test suite (14 tests covering OAuth2, order payloads, captures, and webhooks)
python3 -m unittest -v test_paypal_sandbox_client.py
```

### Expected Output:
```
test_build_create_order_payload_structure ... ok
test_capture_order_invalid_id_rejected ... ok
test_capture_order_without_credentials_fails_closed ... ok
test_create_order_mock_api_success ... ok
test_create_order_without_credentials_fails_closed ... ok
test_generate_ai_market_intelligence_success ... ok
test_generate_ai_market_intelligence_unverified_payment_rejected ... ok
test_generate_ai_requires_real_provider ... ok
test_oauth2_missing_credentials_returns_none ... ok
test_oauth2_mock_success_token ... ok
test_verify_webhook_headers_without_credentials_fail_closed ... ok
test_verify_webhook_invalid_json_fails ... ok
test_verify_webhook_missing_headers_fails ... ok
test_verify_webhook_official_api_success ... ok

Ran 14 tests in 0.004s
OK
```

---

## 3. Key Deliverables & Documentation

- [PayPal Sandbox Verification & Architecture Report](./PAYPAL_SANDBOX_VERIFICATION.md)
- [Recorded Live Sandbox Order Receipt](./paypal_verified_execution_proof.json)
- [Python Client Implementation](./paypal_sandbox_client.py)
- [Pre-Existing Technology Disclosure](./PREEXISTING_TECHNOLOGY.md)
- [Verification Evidence Log](./VERIFICATION_EVIDENCE.md)
