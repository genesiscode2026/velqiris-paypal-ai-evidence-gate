const assert = require('node:assert/strict')

const originalFetch = global.fetch

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

async function run() {
  global.fetch = async (url) => {
    if (url.includes('coinbase')) return response({ data: { amount: '100.00' } })
    if (url.includes('binance')) return response({ price: '101.00' })
    if (url.includes('okx')) return response({ data: [{ last: '99.00' }] })
    throw new Error('unexpected URL')
  }
  delete require.cache[require.resolve('../netlify/functions/alexa-simulation.js')]
  const { handler } = require('../netlify/functions/alexa-simulation.js')

  const consensus = await handler({ httpMethod: 'POST', body: JSON.stringify({ symbol: 'BTC', intent: 'consensus' }) })
  assert.equal(consensus.statusCode, 200)
  const consensusBody = JSON.parse(consensus.body)
  assert.equal(consensusBody.consensus_price_usd, 100)
  assert.equal(consensusBody.source_count, 3)

  const risk = await handler({ httpMethod: 'POST', body: JSON.stringify({ symbol: 'ETH', intent: 'risk_check' }) })
  const riskBody = JSON.parse(risk.body)
  assert.equal(riskBody.regime, null)
  assert.equal(riskBody.risk_status, 'INSUFFICIENT_TIME_SERIES_FOR_REGIME_FORECAST')

  const unsupported = await handler({ httpMethod: 'POST', body: JSON.stringify({ symbol: 'DOGE' }) })
  assert.equal(unsupported.statusCode, 400)

  global.fetch = async () => { throw new Error('offline') }
  const unavailable = await handler({ httpMethod: 'POST', body: JSON.stringify({ symbol: 'BTC' }) })
  assert.equal(unavailable.statusCode, 503)
  assert.equal(JSON.parse(unavailable.body).status, 'INSUFFICIENT_INDEPENDENT_SOURCES')

  console.log('PASS alexa simulation: 4 checks')
}

run().finally(() => { global.fetch = originalFetch }).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
