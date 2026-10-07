const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../netlify/functions/paypal-sandbox");

const response = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

test("status discloses sandbox configuration without secrets", async () => {
  const result = await createHandler({ clientId: "id", clientSecret: "secret" })({ httpMethod: "GET" });
  assert.deepEqual(JSON.parse(result.body), { environment: "PayPal Sandbox", configured: true, liveMoney: false });
  assert.doesNotMatch(result.body, /secret/);
});

test("fails closed without sandbox credentials", async () => {
  const result = await createHandler({ clientId: "", clientSecret: "" })({ httpMethod: "POST", body: '{"symbol":"BTC"}' });
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.body).error, "PAYPAL_SANDBOX_NOT_CONFIGURED");
});

test("uses OAuth then creates a one-dollar sandbox order", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/v1/oauth2/token")) return response(200, { access_token: "sandbox-token" });
    return response(201, { id: "ORDER-123", status: "CREATED", links: [{ rel: "approve", href: "https://sandbox.paypal.com/test" }] });
  };
  const handler = createHandler({ fetchImpl, clientId: "client", clientSecret: "secret" });
  const result = await handler({ httpMethod: "POST", body: '{"symbol":"BTC"}' });
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(body.status, "SANDBOX_ORDER_CREATED");
  assert.equal(body.liveMoney, false);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].options.body).purchase_units[0].amount.value, "1.00");
  assert.doesNotMatch(result.body, /sandbox-token|secret/);
});

