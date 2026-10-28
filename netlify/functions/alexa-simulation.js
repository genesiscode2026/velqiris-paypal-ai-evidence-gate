const ALLOWED_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'ICP'])

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'https://velqiris-acquisition.netlify.app', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(body) }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'VELQIRIS-Alexa-Simulation/1.0' }, signal: AbortSignal.timeout(3500) })
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
  return response.json()
}

async function collectPrices(symbol) {
  const requests = [
    ['coinbase', `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`, (d) => Number(d.data.amount)],
    ['binance', `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, (d) => Number(d.price)],
    ['okx', `https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`, (d) => Number(d.data[0].last)],
  ]
  const settled = await Promise.allSettled(requests.map(async ([name, url, parse]) => {
    const value = parse(await fetchJson(url))
    if (!Number.isFinite(value) || value <= 0) throw new Error('INVALID_PRICE')
    return [name, value]
  }))
  return Object.fromEntries(settled.filter((item) => item.status === 'fulfilled').map((item) => item.value))
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {})
  if (event.httpMethod !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' })

  let input
  try { input = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'INVALID_JSON' }) }
  const symbol = String(input.symbol || 'BTC').toUpperCase()
  if (!ALLOWED_SYMBOLS.has(symbol)) return json(400, { error: 'UNSUPPORTED_SYMBOL' })

  const prices = await collectPrices(symbol)
  const values = Object.values(prices)
  if (values.length < 2) return json(503, { status: 'INSUFFICIENT_INDEPENDENT_SOURCES', symbol, source_count: values.length, sources: prices, spoken_response: `I cannot verify ${symbol} from at least two independent venues right now.` })

  const consensus = median(values)
  const spreadBps = ((Math.max(...values) - Math.min(...values)) / consensus) * 10000
  const base = { status: 'VERIFIED_MULTI_VENUE_SNAPSHOT', symbol, observed_at: new Date().toISOString(), consensus_price_usd: Number(consensus.toFixed(2)), spread_basis_points: Number(spreadBps.toFixed(2)), source_count: values.length, sources: prices }
  if (input.intent === 'risk_check') return json(200, { ...base, regime: null, confidence: 0, risk_status: 'INSUFFICIENT_TIME_SERIES_FOR_REGIME_FORECAST', spoken_response: `The ${symbol} spot snapshot is verified across ${values.length} venues, but a market regime cannot be inferred from one point in time.` })
  return json(200, { ...base, spoken_response: `The verified ${symbol} consensus is ${consensus.toFixed(2)} US dollars across ${values.length} independent venues.` })
}
