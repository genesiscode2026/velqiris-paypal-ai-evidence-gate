'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { getAllowedOrigin, integrityHash, submitNetlifyForm } = require('./form-storage');

const AUTHORIZED_CONTACT_EMAIL = 'chitara.trading@proton.me';
const RETENTION_REVIEW_DAYS = 90;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_CACHE = new Map();
const VALID_PACKAGES = new Set([
  'Turnkey Full Asset Acquisition ($9,999 USDC)',
  'MYMSYL WebGL Heatmap License ($2,999 USDC)',
  'Ingestion Canister License ($1,999 USDC)',
  'VIP Alpha Signals / Commercial Partnership',
]);
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'tempmail.com', 'guerrillamail.com',
  'throwawaymail.com', 'trashmail.com', 'sharklasers.com', 'yopmail.com',
]);

function responseHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '';
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(origin),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function jsonResponse(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function checkRateLimit(ipHash) {
  const now = Date.now();
  const timestamps = (RATE_LIMIT_CACHE.get(ipHash) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) return false;
  timestamps.push(now);
  RATE_LIMIT_CACHE.set(ipHash, timestamps);
  return true;
}

async function notifyOwner(leadRecord) {
  const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!webhookUrl) return { status: 'NOT_CONFIGURED', channel: null };

  try {
    const payload = JSON.stringify({
      text: [
        '[NEW VELQIRIS ACQUISITION LEAD]',
        `Lead ID: ${leadRecord.lead_id}`,
        `Name: ${leadRecord.name}`,
        `Email: ${leadRecord.email}`,
        `Organization: ${leadRecord.organization}`,
        `Package: ${leadRecord.package_interest}`,
      ].join('\n'),
    });
    const url = new URL(webhookUrl);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('UNSUPPORTED_WEBHOOK_PROTOCOL');
    const client = url.protocol === 'https:' ? https : http;
    const statusCode = await new Promise((resolve, reject) => {
      const req = client.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 4000,
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('WEBHOOK_TIMEOUT')));
      req.write(payload);
      req.end();
    });
    if (statusCode < 200 || statusCode >= 300) return { status: 'FAILED', channel: 'webhook', http_status: statusCode };
    return { status: 'DELIVERED', channel: 'webhook', http_status: statusCode };
  } catch (error) {
    return { status: 'FAILED', channel: 'webhook', error: String(error.message || error) };
  }
}

async function recordDeletionRequest(data) {
  const email = String(data.email || '').trim().toLowerCase();
  const leadId = String(data.lead_id || '').trim();
  if (!email || !leadId) throw new Error('MISSING_PARAMETERS');
  const record = {
    record_id: `delete_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    lead_id: leadId,
    email,
    requested_at: new Date().toISOString(),
    status: 'PENDING_VERIFIED_DELETION',
  };
  record.integrity_sha256 = integrityHash(record);
  await submitNetlifyForm('velqiris-deletion-requests', record);
  return record;
}

exports.handler = async (event) => {
  const headers = responseHeaders(event);
  if (event.httpMethod === 'OPTIONS') return jsonResponse(204, headers, {});

  let data = {};
  try {
    data = event.body ? JSON.parse(event.body) : {};
  } catch (_error) {
    return jsonResponse(400, headers, { ok: false, error: 'INVALID_JSON_BODY' });
  }

  if (event.httpMethod === 'DELETE' || data.action === 'delete_request') {
    try {
      const record = await recordDeletionRequest(data);
      return jsonResponse(202, headers, {
        ok: true,
        status: 'DELETION_REQUEST_RECORDED',
        request_id: record.record_id,
        message: 'Deletion request recorded for identity verification and processing.',
      });
    } catch (error) {
      const code = error.message === 'MISSING_PARAMETERS' ? 400 : 503;
      return jsonResponse(code, headers, { ok: false, error: error.message || 'DELETION_REQUEST_FAILED' });
    }
  }

  if (event.httpMethod !== 'POST') return jsonResponse(405, headers, { ok: false, error: 'METHOD_NOT_ALLOWED' });

  const rawIp = String(event.headers?.['x-forwarded-for'] || event.headers?.['client-ip'] || '127.0.0.1')
    .split(',')[0].trim();
  const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex').substring(0, 16);
  if (!checkRateLimit(ipHash)) {
    return jsonResponse(429, { ...headers, 'Retry-After': '600' }, { ok: false, error: 'RATE_LIMIT_EXCEEDED' });
  }

  const honeypot = data.b_phone_check || data.bot_field || data.company_url_hp;
  if (String(honeypot || '').trim()) return jsonResponse(400, headers, { ok: false, error: 'SPAM_SUPPRESSED' });

  const clientTimestamp = Number.parseInt(data.load_timestamp || 0, 10);
  if (!clientTimestamp || Date.now() - clientTimestamp < 2500 || clientTimestamp > Date.now()) {
    return jsonResponse(400, headers, { ok: false, error: 'TIMING_OUT_OF_BOUNDS' });
  }

  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim().toLowerCase();
  const organization = String(data.org || 'Independent / Unspecified').trim().substring(0, 160);
  const buyerType = String(data.buyer_type || 'Unspecified').trim().substring(0, 120);
  const selectedPackage = String(data.package || '').trim();
  const timeline = String(data.timeline || 'Unspecified').trim().substring(0, 100);
  const notes = String(data.notes || '').trim().substring(0, 2000);

  if (name.length < 2 || name.length > 100) return jsonResponse(400, headers, { ok: false, error: 'VALIDATION_FAILED', field: 'name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return jsonResponse(400, headers, { ok: false, error: 'VALIDATION_FAILED', field: 'email' });
  if (DISPOSABLE_DOMAINS.has(email.split('@')[1])) return jsonResponse(400, headers, { ok: false, error: 'DISPOSABLE_EMAIL_REJECTED' });
  if (!VALID_PACKAGES.has(selectedPackage)) return jsonResponse(400, headers, { ok: false, error: 'VALIDATION_FAILED', field: 'package' });
  if (data.consent !== true) return jsonResponse(400, headers, { ok: false, error: 'CONSENT_REQUIRED' });

  const now = Date.now();
  const leadRecord = {
    lead_id: `lead_${now}_${crypto.randomBytes(4).toString('hex')}`,
    name,
    email,
    organization,
    buyer_type: buyerType,
    package_interest: selectedPackage,
    closing_timeline: timeline,
    specific_notes: notes,
    received_at: new Date(now).toISOString(),
    retention_review_at: new Date(now + RETENTION_REVIEW_DAYS * 86400000).toISOString(),
    consent_scope: 'transaction_due_diligence',
    status: 'RECORDED',
  };
  leadRecord.integrity_sha256 = integrityHash(leadRecord);

  let persistence;
  try {
    persistence = await submitNetlifyForm('velqiris-acquisition-leads', leadRecord);
  } catch (error) {
    return jsonResponse(503, headers, { ok: false, error: 'DURABLE_STORAGE_FAILED', detail: String(error.message || error) });
  }

  const notification = await notifyOwner(leadRecord);
  return jsonResponse(201, headers, {
    ok: true,
    lead_id: leadRecord.lead_id,
    status: 'RECORDED_DURABLY',
    persistence,
    notification,
    retention_review_at: leadRecord.retention_review_at,
    summary: { name, organization, package: selectedPackage },
    message: notification.status === 'DELIVERED'
      ? 'Inquiry stored and owner notification delivered.'
      : 'Inquiry stored. Owner notification delivery is not yet configured or did not succeed.',
  });
};

exports.config = {
  rateLimit: { action: 'rate_limit', aggregateBy: ['domain', 'ip'], windowSize: 600, windowLimit: 5 },
};

exports._test = { checkRateLimit, notifyOwner, recordDeletionRequest };
