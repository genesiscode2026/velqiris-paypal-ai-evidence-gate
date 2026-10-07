const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";

function reply(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function createHandler({
  fetchImpl = fetch,
  clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID,
  clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET,
} = {}) {
  return async function handler(event) {
    if (event.httpMethod === "GET") {
      return reply(200, {
        environment: "PayPal Sandbox",
        configured: Boolean(clientId && clientSecret),
        liveMoney: false,
      });
    }
    if (event.httpMethod !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
    if (!clientId || !clientSecret) {
      return reply(503, { error: "PAYPAL_SANDBOX_NOT_CONFIGURED", message: "No sandbox order was created." });
    }

    let input;
    try { input = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "INVALID_JSON" }); }
    const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return reply(400, { error: "INVALID_SYMBOL" });

    try {
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const tokenResponse = await fetchImpl(`${PAYPAL_BASE}/v1/oauth2/token`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      const tokenBody = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(`OAuth HTTP ${tokenResponse.status}`);

      const orderResponse = await fetchImpl(`${PAYPAL_BASE}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: `evidence_${symbol.toLowerCase()}`,
            description: `VELQIRIS evidence session (${symbol})`,
            amount: { currency_code: "USD", value: "1.00" },
          }],
          payment_source: { paypal: { experience_context: { user_action: "PAY_NOW" } } },
        }),
      });
      const order = await orderResponse.json();
      if (!orderResponse.ok) throw new Error(`Create order HTTP ${orderResponse.status}`);
      return reply(200, {
        status: "SANDBOX_ORDER_CREATED",
        environment: "PayPal Sandbox",
        liveMoney: false,
        order: { id: order.id, status: order.status, links: order.links || [] },
      });
    } catch (error) {
      return reply(502, { error: "PAYPAL_SANDBOX_UPSTREAM_FAILURE", message: error.message });
    }
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;

