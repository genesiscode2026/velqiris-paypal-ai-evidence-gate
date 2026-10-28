'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velqiris-lead-tests-'));
process.env.VELQIRIS_TEST_DATA_DIR = testDataDir;
delete process.env.NOTIFICATION_WEBHOOK_URL;

const { handler: leadHandler } = require('../netlify/functions/lead-capture');
const { handler: analyticsHandler } = require('../netlify/functions/analytics');

function validLead(ip, overrides = {}) {
  return {
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': ip, origin: 'http://localhost:3000' },
    body: JSON.stringify({
      name: 'Elena Rostova',
      email: 'elena@apexcapital.xyz',
      org: 'Apex Capital Management',
      buyer_type: 'Hedge Fund / Prop Trading Desk',
      package: 'Turnkey Full Asset Acquisition ($9,999 USDC)',
      timeline: 'Immediate (< 14 days)',
      notes: 'Local integration fixture only.',
      consent: true,
      load_timestamp: Date.now() - 5000,
      b_phone_check: '',
      ...overrides,
    }),
  };
}

async function runTests() {
  try {
    const created = await leadHandler(validLead('198.51.100.42'));
    assert.strictEqual(created.statusCode, 201);
    const createdBody = JSON.parse(created.body);
    assert.strictEqual(createdBody.status, 'RECORDED_DURABLY');
    assert.strictEqual(createdBody.persistence.mode, 'LOCAL_TEST_LEDGER');
    assert.strictEqual(createdBody.notification.status, 'NOT_CONFIGURED');
    console.log('✓ valid lead is persisted and notification status remains honest');

    const leadLedger = path.join(testDataDir, 'velqiris-acquisition-leads.jsonl');
    assert.ok(fs.existsSync(leadLedger));
    const storedLead = JSON.parse(fs.readFileSync(leadLedger, 'utf8').trim());
    assert.strictEqual(storedLead.lead_id, createdBody.lead_id);
    assert.match(storedLead.integrity_sha256, /^[a-f0-9]{64}$/);
    assert.ok(storedLead.retention_review_at);
    console.log('✓ isolated ledger contains integrity hash and retention review date');

    const spam = await leadHandler(validLead('198.51.100.43', { b_phone_check: 'https://spam.invalid' }));
    assert.strictEqual(spam.statusCode, 400);
    assert.strictEqual(JSON.parse(spam.body).error, 'SPAM_SUPPRESSED');
    console.log('✓ honeypot blocks automated submission');

    const disposable = await leadHandler(validLead('198.51.100.44', { email: 'bot@mailinator.com' }));
    assert.strictEqual(disposable.statusCode, 400);
    assert.strictEqual(JSON.parse(disposable.body).error, 'DISPOSABLE_EMAIL_REJECTED');
    console.log('✓ disposable email is rejected');

    const invalidPackage = await leadHandler(validLead('198.51.100.45', { package: 'Invented package' }));
    assert.strictEqual(invalidPackage.statusCode, 400);
    assert.strictEqual(JSON.parse(invalidPackage.body).field, 'package');
    console.log('✓ package allowlist is enforced');

    const tooFast = await leadHandler(validLead('198.51.100.46', { load_timestamp: Date.now() }));
    assert.strictEqual(tooFast.statusCode, 400);
    assert.strictEqual(JSON.parse(tooFast.body).error, 'TIMING_OUT_OF_BOUNDS');
    console.log('✓ submission timing check is enforced');

    const rateIp = '203.0.113.88';
    for (let index = 0; index < 5; index += 1) {
      const response = await leadHandler(validLead(rateIp, { email: `buyer${index}@validfirm.example` }));
      assert.strictEqual(response.statusCode, 201);
    }
    const limited = await leadHandler(validLead(rateIp, { email: 'limited@validfirm.example' }));
    assert.strictEqual(limited.statusCode, 429);
    assert.strictEqual(limited.headers['Retry-After'], '600');
    console.log('✓ local and platform rate-limit contract is enforced');

    const deletion = await leadHandler({
      httpMethod: 'DELETE', headers: {}, body: JSON.stringify({ lead_id: createdBody.lead_id, email: 'elena@apexcapital.xyz' }),
    });
    assert.strictEqual(deletion.statusCode, 202);
    assert.strictEqual(JSON.parse(deletion.body).status, 'DELETION_REQUEST_RECORDED');
    assert.ok(fs.existsSync(path.join(testDataDir, 'velqiris-deletion-requests.jsonl')));
    console.log('✓ deletion request is recorded without falsely claiming immediate purge');

    const eventPost = await analyticsHandler({
      httpMethod: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({
        event_name: 'offer_viewed', session_id: 'sess_test_123', path: '/#buyout',
        referrer: 'https://news.ycombinator.com/item?id=1', metadata: { offer: 'turnkey_buyout', price: 9999 },
      }),
    });
    assert.strictEqual(eventPost.statusCode, 201);
    assert.strictEqual(JSON.parse(eventPost.body).status, 'RECORDED_DURABLY');
    const analyticsGet = await analyticsHandler({ httpMethod: 'GET', headers: {} });
    assert.strictEqual(analyticsGet.statusCode, 200);
    assert.strictEqual(JSON.parse(analyticsGet.body).summary.metrics.offer_viewed, 1);
    console.log('✓ analytics uses isolated persistent adapter and aggregates locally only in test mode');

    console.log('ALL 9 LEAD-CAPTURE AND ANALYTICS INTEGRATION CHECKS PASSED');
  } finally {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error('Test Suite Failed:', error);
  process.exitCode = 1;
});
