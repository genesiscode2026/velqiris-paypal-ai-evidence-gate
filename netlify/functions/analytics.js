'use strict';

const crypto = require('crypto');
const { getAllowedOrigin, integrityHash, isLocalTestMode, readLocalTestRecords, submitNetlifyForm } = require('./form-storage');

const ALLOWED_EVENTS = new Set(['page_view', 'offer_viewed', 'cta_clicked', 'form_started', 'form_submitted']);

function headersFor(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '';
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(origin),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function reply(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).slice(0, 10).map(([key, value]) => [
    String(key).substring(0, 40),
    String(value).substring(0, 160),
  ]));
}

function aggregate(events) {
  const metrics = Object.fromEntries(Array.from(ALLOWED_EVENTS, (name) => [name, 0]));
  const sessions = new Set();
  for (const event of events) {
    if (event.event_name in metrics) metrics[event.event_name] += 1;
    if (event.session_id) sessions.add(event.session_id);
  }
  return {
    total_events_recorded: events.length,
    unique_sessions: sessions.size,
    metrics,
    conversion_rate_percent: metrics.page_view
      ? Number(((metrics.form_submitted / metrics.page_view) * 100).toFixed(2))
      : 0,
    last_event_timestamp: events.length ? events[events.length - 1].timestamp : null,
  };
}

exports.handler = async (event) => {
  const headers = headersFor(event);
  if (event.httpMethod === 'OPTIONS') return reply(204, headers, {});

  if (event.httpMethod === 'GET') {
    if (!isLocalTestMode()) {
      return reply(405, headers, {
        ok: false,
        error: 'PUBLIC_ANALYTICS_READ_DISABLED',
        message: 'Use the authenticated Netlify Forms dashboard for aggregate telemetry.',
      });
    }
    return reply(200, headers, { ok: true, summary: aggregate(readLocalTestRecords('velqiris-analytics')) });
  }

  if (event.httpMethod !== 'POST') return reply(405, headers, { ok: false, error: 'METHOD_NOT_ALLOWED' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_error) {
    return reply(400, headers, { ok: false, error: 'INVALID_JSON_BODY' });
  }

  const eventName = String(body.event_name || '').trim();
  if (!ALLOWED_EVENTS.has(eventName)) return reply(400, headers, { ok: false, error: 'INVALID_EVENT_NAME' });

  const record = {
    event_id: `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    event_name: eventName,
    session_id: String(body.session_id || 'anonymous').substring(0, 36),
    path: String(body.path || '/').substring(0, 120),
    referrer_origin: (() => {
      try { return new URL(String(body.referrer || '')).origin; } catch (_error) { return 'direct'; }
    })(),
    metadata: sanitizeMetadata(body.metadata),
    timestamp: new Date().toISOString(),
  };
  record.integrity_sha256 = integrityHash(record);

  try {
    const persistence = await submitNetlifyForm('velqiris-analytics', record);
    return reply(201, headers, { ok: true, event_id: record.event_id, status: 'RECORDED_DURABLY', persistence });
  } catch (error) {
    return reply(503, headers, { ok: false, error: 'DURABLE_STORAGE_FAILED', detail: String(error.message || error) });
  }
};

exports._test = { aggregate, sanitizeMetadata };
