# VELQIRIS PayPal Sandbox Intelligence Gate

A PayPal sandbox and AI integration candidate for the PayPal AI Hackathon.

## Live demo & Sandbox Evidence

- Demo UI: https://velqiris-acquisition.netlify.app/paypal-sandbox.html
- Live Sandbox OAuth & Order Verification: **CONFIRMED** on PayPal Developer Sandbox REST API v2
- Verified Live Sandbox Orders:
  - Order `9XA64288V69271501` (status: `CREATED`, value: `$19.00 USD`)
  - Order `25L40064784857115` (status: `CREATED`, value: `$1.00 USD`)
- Registered Official Webhook: ID `4HN53346UF6053313` (`https://velqiris-acquisition.netlify.app/.netlify/functions/paypal-webhook`)
- App ID: `APP-8PD12437MX953783S`
- Merchant ID: `528WKSF7HVQHA`
- Strict $0 Real-Money Policy: All operations executed strictly within developer sandbox mode.

## Implemented locally

- PayPal sandbox OAuth and order creation/capture client.
- Official PayPal webhook-verification API path.
- Fail-closed handling when credentials or webhook ID are missing.
- AI step gated by a completed capture, provenance-bearing telemetry from at least two sources, and an explicit reasoning provider.
- Public-demo UI and serverless PayPal Sandbox OAuth/order path, fixed to a one-dollar sandbox order and explicitly marked as zero real money.

## Test

```bash
python3 test_paypal_sandbox_client.py
node --test test/paypal-sandbox.test.js
```

## Submission gate

A compliant submission still requires sandbox credentials, an actual completed sandbox flow, verified webhook evidence, a configured AI provider, a public demo and a short video. Local mocked tests are not represented as PayPal execution.

## License

MIT.
