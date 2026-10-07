# VELQIRIS PayPal Sandbox Intelligence Gate

A PayPal sandbox and AI integration candidate for the PayPal AI Hackathon.

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
